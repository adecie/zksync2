/**
 * This file provides the SwapClient class - essentially a client-side part of the SDK
 * @packageDocumentation
 */

import * as zksync from 'zksync';
import { pubKeyHash } from 'zksync-crypto';
import { providers, utils } from 'ethers';
import { MusigSigner } from './signer';
import { SwapData, SwapState } from './types';
import { transpose, getTransactions, formatTx, SYNC_TX_PREFIX, TOTAL_TRANSACTIONS } from './utils';

import { SwapParty } from './abstract-party';

// This is the client's position in schnorr-musig protocol
const CLIENT_MUSIG_POSITION = 1;

/** SwapClient class provides all necessary methods to prepare, sign and complete the swap on the client side. */
export class SwapClient extends SwapParty {
    private commitments: Uint8Array[];

    /** async factory method */
    static async init(privateKey: string, ethProvider: providers.Provider, syncProvider: zksync.Provider) {
        return (await super.init(privateKey, ethProvider, syncProvider)) as SwapClient;
    }

    async loadSwap(swapData: SwapData, signedTransactions: any[]) {
        if (this.state != SwapState.empty) {
            throw new Error("In the middle of a swap - can't switch to a new one");
        }
        this.swapData = swapData;
        this.transactions = signedTransactions;
        const swapAddress = signedTransactions[0].account;
        const swapAccount = await this.syncWallet.provider.getState(swapAddress);
        const balance = swapAccount.committed.balances[swapData.sell.token];
        this.state = swapData.sell.amount.gt(balance) ? SwapState.signed : SwapState.deposited;
    }

    signedTransactions() {
        if (this.state != SwapState.signed && this.state != SwapState.deposited) {
            throw new Error('Transactions are not signed yet');
        }
        return this.transactions;
    }

    /**
     * This method generates precommitments and commitments for schnorr-musig protocol,
     * makes a 0-transfer to the multisig account so that the server assigns an ID to it, and generates
     * all 5 transactions needed for the swap.
     * @returns precommitments and commitments for schnorr-musig protocol to be sent to provider
     */
    async prepareSwap(
        data: SwapData,
        providerPubkey: string,
        providerAddress: string,
        providerPrecommitments: Uint8Array[]
    ) {
        if (this.state != SwapState.empty) {
            throw new Error("In the middle of a swap - can't start a new one");
        }
        this.swapData = data;
        this.signer = new MusigSigner([providerPubkey, this.publicKey], CLIENT_MUSIG_POSITION, TOTAL_TRANSACTIONS);
        const precommitments = this.signer.computePrecommitments();
        this.commitments = this.signer.receivePrecommitments(transpose([providerPrecommitments, precommitments]));
        this.pubKeyHash = pubKeyHash(this.signer.computePubkey());
        this.create2Info = zksync.utils.getCREATE2AddressAndSalt(utils.hexlify(this.pubKeyHash), {
            creatorAddress: data.create2.creator,
            saltArg: data.create2.salt,
            codeHash: data.create2.hash
        });

        // if the swapAccount has not yet been created (has no id)
        // we have to make a 0-transfer to it so it will be created,
        // otherwise we won't be able to sign outcoming transactions
        const swapAccount = await this.syncWallet.provider.getState(this.create2Info.address);
        if (!swapAccount.id) {
            const tx = await this.syncWallet.syncTransfer({
                to: this.create2Info.address,
                token: data.sell.token,
                amount: 0
            });
            await tx.awaitReceipt();
        }

        // generate swap transactions
        this.transactions = await getTransactions(
            this.swapData,
            this.syncWallet.address(),
            providerAddress,
            this.create2Info.address,
            this.pubKeyHash,
            this.syncWallet.provider
        );

        this.state = SwapState.prepared;
        return {
            precommitments,
            commitments: this.commitments
        };
    }

    /**
     * This method receives commitments and signature shares generated by the provider,
     * generates client's signature shares and combines them into full transaction signatures.
     *
     * If signatures are correct, method transfers client's funds to the multisig, otherwise an error is thrown.
     * @returns signature shares to send to the provider
     */
    async signSwap(data: { commitments: Uint8Array[]; shares: Uint8Array[] }) {
        if (this.state != SwapState.prepared) {
            throw new Error('Not prepared for the swap');
        }
        this.signer.receiveCommitments(transpose([data.commitments, this.commitments]));
        const musigPubkey = this.signer.computePubkey();
        let shares = [];

        // sign all transactions
        this.transactions.forEach((tx, i) => {
            const bytes = this.getSignBytes(tx);
            const share = this.signer.sign(this.privateKey, bytes, i);
            const signature = this.signer.receiveSignatureShares([data.shares[i], share], i);
            shares.push(share);
            // this could mean that either provider sent incorrect signature shares
            // or provider signed transactions containing wrong data
            if (!this.signer.verify(bytes, signature)) {
                throw new Error('Provided signature shares are invalid');
            }
            formatTx(tx, signature, musigPubkey);
        });

        this.state = SwapState.signed;
        return shares;
    }

    /** Deposits client's funds to the multisig account */
    async depositFunds(depositType: 'L1' | 'L2' = 'L2', autoApprove: boolean = true) {
        if (this.state != SwapState.signed) {
            throw new Error("Not yet signed the transactions - can't deposit funds");
        }
        const hash = await this.deposit(this.swapData.sell.token, this.swapData.sell.amount, depositType, autoApprove);
        this.state = SwapState.deposited;
        return hash;
    }

    /**
     * Waits until the transaction that finalizes the swap is sent onchain.
     * @returns true if the transaction is sent before the timeout, false otherwise
     */
    async wait(action: 'COMMIT' | 'VERIFY' = 'COMMIT') {
        if (this.state != SwapState.deposited) {
            throw new Error('No funds on the swap account - nothing to wait for');
        }
        const hash = utils.sha256(this.getSignBytes(this.transactions[1]));
        const timeout = this.swapData.timeout * 1000 - Date.now();
        const result = await Promise.race([
            this.syncWallet.provider.notifyTransaction(hash.replace('0x', SYNC_TX_PREFIX), action),
            new Promise((resolve) => setTimeout(resolve, timeout, null))
        ]);
        if (result) {
            this.state = SwapState.finalized;
        }
        return result !== null;
    }

    /** Sends transactions that will finalize the swap */
    async finalizeSwap() {
        const swapAccount = await this.syncWallet.provider.getState(this.swapAddress());
        const balance = swapAccount.committed.balances[this.swapData.buy.token];
        if (this.state != SwapState.deposited || this.swapData.buy.amount.gt(balance)) {
            throw new Error('No funds on the swap account - nothing to finalize');
        }
        await this.sendBatch([this.transactions[0]], this.swapData.sell.token);
        const hashes = await this.sendBatch([this.transactions[1]], this.swapData.sell.token);
        this.state = SwapState.finalized;
        return hashes;
    }

    /** Cancels the swap and returns all client's funds from the swap account */
    async cancelSwap() {
        if (Date.now() < this.swapData.timeout * 1000) {
            throw new Error('Too early to cancel the swap');
        }
        if (this.state != SwapState.deposited) {
            throw new Error('No funds on the swap account - nothing to cancel');
        }
        await this.sendBatch([this.transactions[0]], this.swapData.sell.token);
        const hashes = await this.sendBatch([this.transactions[3]], this.swapData.sell.token);
        this.state = SwapState.finalized;
        return hashes;
    }
}
