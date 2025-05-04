mod config;
mod custody;

use dep::aztec::macros::aztec;

#[aztec]
pub contract pSymm {
    use dep::aztec::{
        context::UtilityContext,
        macros::{
            functions::{initializer, private, public, view, utility, internal},
            storage::storage,
        },
        prelude::{AztecAddress, Map, PrivateSet, PublicImmutable},
        note::note_viewer_options::NoteViewerOptions,
    };

    use dep::token::Token;
    use dep::types::traits::FromField;

    use crate::config::Config;
    use crate::custody::{Custody, DepositNote};

    global MAX_COUNTERPARTIES: u32 = 3;

    #[storage]
    struct Storage<Context> {
        /// L2 token address for custody operations
        config: PublicImmutable<Config, Context>,
        /// custody_id -> N*N of notes (N deposit notes with N owners)
        custody_map: Map<Field, Custody<Context>, Context>,
    }

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

    #[utility]
    unconstrained fn custody_balance(custody_id: Field, deposit_owner: AztecAddress) -> Field {
        let balances = storage.custody_map;

        let set = balances.at(custody_id).set;

        get_balance_with_offset(set, 0, deposit_owner)
    }

    #[utility]
    #[internal]
    pub unconstrained fn get_balance_with_offset(
        set: PrivateSet<DepositNote, UtilityContext>,
        offset: u32,
        deposit_owner: AztecAddress
    ) -> Field {
        let mut balance = 0;
        let mut options = NoteViewerOptions::new();
        let notes = set.view_notes(options.set_offset(offset));
        for i in 0..options.limit {
            if i < notes.len() {
                let note = notes.get_unchecked(i);
                // doublecheck to prevent duplicate read on multi-account PXE in same custody
                if note.deposit_owner().eq(deposit_owner) & note.owner().eq(deposit_owner) {
                    balance += note.deposit_amount();
                }
            }
        }

        if (notes.len() == options.limit) {
            balance += get_balance_with_offset(set, offset + options.limit, deposit_owner);
        }

        balance
    }


    #[private]
    fn address_to_custody(
        from: AztecAddress,
        // counterparties used to share note ownership
        counterparties: [AztecAddress; MAX_COUNTERPARTIES],
        custody_id: Field,
        amount: u64, nonce: Field
    ) {
        // assert from is sender
        let cfg = storage.config.read();
        Token::at(cfg.token)
            .transfer_to_public(from, context.this_address(), amount as u128, nonce)
            .call(&mut context);

        storage.custody_map.at(custody_id).add(amount, from, from);
        for i in 0..MAX_COUNTERPARTIES {
            if !counterparties[i].eq(AztecAddress::from_field(0)) {
                storage.custody_map.at(custody_id).add(amount, from, counterparties[i]);
            }
        }
    }

    #[private]
    fn custody_to_address(
        to: AztecAddress, counterparties: [AztecAddress; MAX_COUNTERPARTIES],
        custody_id: Field, amount: u64
    ) {
        storage.custody_map.at(custody_id).sub(amount, to, to);
        for i in 0..MAX_COUNTERPARTIES {
            if !counterparties[i].eq(AztecAddress::from_field(0)) {
                storage.custody_map.at(custody_id).sub(amount, to, counterparties[i]);
            }
        }

        let cfg = storage.config.read();
        Token::at(cfg.token)
            .transfer_in_public(context.this_address(), to, amount as u128, 0)
            .enqueue(&mut context);

    }
}
