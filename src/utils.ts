import { ethers, utils } from 'ethers';
import * as zksync from 'zksync';
import { private_key_to_pubkey, privateKeyFromSeed } from 'zksync-crypto';
import { SwapData } from './types';

export function transpose<T>(matrix: T[][]): T[][] {
    return matrix[0].map((_, index) => matrix.map((row) => row[index]));
}

export async function getSyncKeys(ethWallet: ethers.Wallet) {
    let chainID = 1;
    if (ethWallet.provider) {
        const network = await ethWallet.provider.getNetwork();
        chainID = network.chainId;
    }
    let message = 'Access zkSync account.\n\nOnly sign this message for a trusted client!';
    if (chainID !== 1) {
        message += `\nChain ID: ${chainID}.`;
    }
    const signedBytes = zksync.utils.getSignedBytesFromMessage(message, false);
    const signature = await zksync.utils.signMessagePersonalAPI(ethWallet, signedBytes);
    const seed = ethers.utils.arrayify(signature);
    const privkey = privateKeyFromSeed(seed);
    const pubkey = private_key_to_pubkey(privkey);
    return { privkey, pubkey };
}

export function getSignBytes(transaction: any, signer: zksync.Signer): Uint8Array {
    if (transaction.type == 'Transfer') {
        return signer.transferSignBytes(transaction, 'contracts-4');
    } else if (transaction.type == 'Withdraw') {
        return signer.withdrawSignBytes(transaction, 'contracts-4');
    } else if (transaction.type == 'ChangePubKey') {
        return signer.changePubKeySignBytes(transaction, 'contracts-4');
    } else {
        throw new Error('Invalid transaction type');
    }
}

export async function getTransactions(
    swapData: SwapData,
    clientAddress: string,
    providerAddress: string,
    swapAddress: string,
    pubKeyHash: Uint8Array,
    syncProvider: zksync.Provider
): Promise<any[]> {
    const { totalFee: transferSold } = await syncProvider.getTransactionFee(
        'Transfer',
        providerAddress,
        swapData.sell.token
    );
    const { totalFee: transferBought } = await syncProvider.getTransactionFee(
        'Transfer',
        providerAddress,
        swapData.buy.token
    );
    const { totalFee: changePubKey } = await syncProvider.getTransactionFee(
        { ChangePubKey: { onchainPubkeyAuth: false } },
        providerAddress,
        swapData.sell.token
    );
    const { totalFee: withdraw } = await syncProvider.getTransactionFee(
        'Withdraw',
        providerAddress,
        swapData.sell.token
    );
    const fees = { transferSold, transferBought, changePubKey, withdraw };

    const swapAccount = await syncProvider.getState(swapAddress);
    if (!swapAccount.id) {
        throw new Error("Swap Account ID not set - can't sign transactions");
    }
    const buyTokenId = syncProvider.tokenSet.resolveTokenId(swapData.buy.token);
    const sellTokenId = syncProvider.tokenSet.resolveTokenId(swapData.sell.token);

    // prettier-ignore
    return [
    {
        type: 'ChangePubKey',
        accountId: swapAccount.id,
        account: swapAccount.address,
        newPkHash: 'sync:' + utils.hexlify(pubKeyHash).slice(2),
        nonce: 0,
        feeTokenId: sellTokenId,
        fee: fees.changePubKey,
        validFrom: 0,
        validUntil: zksync.utils.MAX_TIMESTAMP,
        ethAuthData: {
            type: 'CREATE2',
            creatorAddress: clientAddress,
            saltArg: swapData.create2.salt,
            codeHash: swapData.create2.hash
        }
    },

    {
        type: 'Transfer',
        tokenId: buyTokenId,
        accountId: swapAccount.id,
        from: swapAccount.address,
        to: clientAddress,
        amount: swapData.buy.amount,
        fee: fees.transferBought,
        feeTokenId: buyTokenId,
        nonce: 1,
        validFrom: 0,
        validUntil: swapData.timeout
    },

    (swapData.withdrawType == 'L1') ? {
        type: 'Withdraw',
        tokenId: sellTokenId,
        accountId: swapAccount.id,
        from: swapAccount.address,
        ethAddress: providerAddress,
        amount: swapData.sell.amount,
        fee: fees.withdraw,
        feeTokenId: sellTokenId,
        nonce: 2,
        validFrom: 0,
        validUntil: zksync.utils.MAX_TIMESTAMP
    } : {
        type: 'Transfer',
        tokenId: sellTokenId,
        accountId: swapAccount.id,
        from: swapAccount.address,
        to: providerAddress,
        amount: swapData.sell.amount,
        fee: fees.transferSold,
        feeTokenId: sellTokenId,
        nonce: 2,
        validFrom: 0,
        validUntil: zksync.utils.MAX_TIMESTAMP
    },

    {
        type: 'Transfer',
        tokenId: sellTokenId,
        accountId: swapAccount.id,
        from: swapAccount.address,
        to: clientAddress,
        amount: swapData.sell.amount,
        fee: fees.transferSold,
        feeTokenId: sellTokenId,
        nonce: 1,
        validFrom: swapData.timeout + 1,
        validUntil: zksync.utils.MAX_TIMESTAMP
    },

    {
        type: 'Transfer',
        tokenId: buyTokenId,
        accountId: swapAccount.id,
        from: swapAccount.address,
        to: providerAddress,
        amount: 0,
        fee: fees.transferBought,
        feeTokenId: buyTokenId,
        nonce: 2,
        validFrom: swapData.timeout + 1,
        validUntil: zksync.utils.MAX_TIMESTAMP
    }];
}
