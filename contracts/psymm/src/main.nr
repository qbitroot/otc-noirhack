mod config;
mod types;

use dep::aztec::macros::aztec;

#[aztec]
pub contract pSymm {
    use dep::aztec::{
        context::PrivateContext,
        macros::{
            functions::{initializer, private, public, view},
            storage::storage,
        },
        prelude::{AztecAddress, Map, PrivateSet, PublicImmutable},
        note::note_interface::{NoteHash, NoteProperties},
        utils::comparison::Comparator,
    };

    use dep::token::Token;

    use crate::types::custody_note::CustodyNote;
    use crate::config::Config;

    #[storage]
    struct Storage<Context> {
        /// L2 token address for custody operations
        config: PublicImmutable<Config, Context>,
        /// Mapping of owner address to private note sets
        custody_notes: Map<AztecAddress, PrivateSet<CustodyNote, Context>, Context>,
    }

    global MAX_NOTES: u32 = 8;

    /// Initialize with the L2 token address
    #[public]
    #[initializer]
    fn constructor(token: AztecAddress) {
        storage.config.initialize(Config { token });
    }

    /// Read-only view of the contract config
    #[private]
    #[view]
    fn get_config() -> Config {
        storage.config.read()
    }
    #[private]
    #[view]
    fn get_custody_balance(custody_id: Field) -> u128 {
        let cfg = storage.config.read();
        let caller = context.msg_sender();
        // Get notes without popping them
        let notes = storage.custody_notes.at(caller).get_notes(
            dep::aztec::prelude::NoteGetterOptions::new()
                .set_limit(MAX_NOTES)
                .select(CustodyNote::properties().custody_id, Comparator.EQ, custody_id)
        );

        let mut total_amount = 0 as u128;
        for i in 0..MAX_NOTES {
            if i < notes.len() {
                total_amount += notes.get_unchecked(i).note.amount;
            }
        }
        total_amount
    }

    /// Deposit `amount` of L2 token into private custody under `custody_id`
    #[private]
    fn deposit(custody_id: Field, amount: u128, nonce: Field) {
        let caller = context.msg_sender();
        let cfg = storage.config.read();

        Token::at(cfg.token)
            .transfer_in_private(caller, context.this_address(), amount, nonce)
            .call(&mut context);

        // Update custody balance by adding a new note owned by the caller
        let new_note = CustodyNote::new(custody_id, amount, caller);
        storage.custody_notes.at(caller).insert(new_note).emit(
            dep::aztec::messages::logs::note::encode_and_encrypt_note(&mut context, caller, caller)
        );
    }

    /// Withdraw `amount` of L2 token from private custody under `custody_id`
    #[private]
    fn withdraw(custody_id: Field, amount: u128) {
        let caller = context.msg_sender();

        // Pop notes to cover the withdrawal amount
        let notes = storage.custody_notes.at(caller).pop_notes(
            dep::aztec::prelude::NoteGetterOptions::new()
                .set_limit(MAX_NOTES)
                .select(CustodyNote::properties().custody_id, Comparator.EQ, custody_id)
        );

        let mut total_amount = 0 as u128;
        for i in 0..MAX_NOTES {
            if i < notes.len() {
                total_amount += notes.get_unchecked(i).get_amount();
                // Compute and push nullifier for each popped note to prevent double-spending
                let note = notes.get_unchecked(i);
                let note_hash = note.compute_note_hash(storage.custody_notes.at(caller).storage_slot);
                let nullifier = note.compute_nullifier(&mut context, note_hash);
                context.push_nullifier(nullifier);
            }
        }

        assert(total_amount >= amount, "Insufficient balance in custody");

        // If there's change, create a new note for the remaining amount
        if total_amount > amount {
            let change_note = CustodyNote::new(custody_id, total_amount - amount, caller);
            storage.custody_notes.at(caller).insert(change_note).emit(
                dep::aztec::messages::logs::note::encode_and_encrypt_note(&mut context, caller, caller)
            );
        }

        // Transfer `amount` of L2 token back to caller (private)
        let cfg = storage.config.read();
        Token::at(cfg.token)
            .transfer_in_private(context.this_address(), caller, amount, 0)
            .call(&mut context);
    }
}
