mod config;

use dep::aztec::macros::aztec;

#[aztec]
pub contract pSymm {
    use dep::aztec::{
        context::{PrivateContext, UtilityContext},
        macros::{
            functions::{initializer, private, public, view, utility, internal},
            storage::storage,
        },
        messages::logs::{
            event::encode_and_encrypt_event_unconstrained,
            note::{encode_and_encrypt_note, encode_and_encrypt_note_unconstrained},
        },
        prelude::{AztecAddress, Map, PrivateSet, PublicImmutable},
        note::note_interface::{NoteHash, NoteProperties},
        note::note_viewer_options::NoteViewerOptions,
        utils::comparison::Comparator,
    };

    use dep::token::Token;
    use dep::types::traits::FromField;
    use dep::easy_private_state::EasyPrivateUint;
    use dep::value_note::value_note::ValueNote;

    use crate::config::Config;

    global MAX_COUNTERPARTIES: u32 = 4;

    #[storage]
    struct Storage<Context> {
        /// L2 token address for custody operations
        config: PublicImmutable<Config, Context>,
        /// custody_id -> N*N of notes (N deposit notes with N owners)
        custody_balances: Map<Field, EasyPrivateUint<Context>, Context>,
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
    unconstrained fn custody_balance(custody_id: Field, sender: AztecAddress) -> Field {
        // sender is only used so that PXEs with multiple addresses registered
        // do not reread same notes multiple times
        let balances = storage.custody_balances;

        let set = balances.at(custody_id).set;

        get_balance_with_offset(set, 0, sender)
    }

    #[utility]
    #[internal]
    pub unconstrained fn get_balance_with_offset(
        set: PrivateSet<ValueNote, UtilityContext>,
        offset: u32,
        addr: AztecAddress
    ) -> Field {
        let mut balance = 0;
        let mut options = NoteViewerOptions::new();
        let notes = set.view_notes(options.set_offset(offset));
        for i in 0..options.limit {
            if i < notes.len() {
                let note = notes.get_unchecked(i);
                if note.owner.eq(addr) {
                    balance += note.value();
                }
            }
        }

        if (notes.len() == options.limit) {
            balance += get_balance_with_offset(set, offset + options.limit, addr);
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
        let cfg = storage.config.read();
        Token::at(cfg.token)
            .transfer_to_public(from, context.this_address(), amount as u128, nonce)
            .call(&mut context);

        storage.custody_balances.at(custody_id).add(amount, context.msg_sender(), context.msg_sender());
        for i in 0..MAX_COUNTERPARTIES {
            if !counterparties[i].eq(AztecAddress::from_field(0)) {
                storage.custody_balances.at(custody_id).add(amount, counterparties[i], counterparties[i]);
            }
        }
    }

    #[private]
    fn custody_to_address(
        to: AztecAddress, counterparties: [AztecAddress; MAX_COUNTERPARTIES],
        custody_id: Field, amount: u64
    ) {
        storage.custody_balances.at(custody_id).sub(amount, context.msg_sender(), context.msg_sender());
        for i in 0..MAX_COUNTERPARTIES {
            if !counterparties[i].eq(AztecAddress::from_field(0)) {
                storage.custody_balances.at(custody_id).sub(amount, counterparties[i], counterparties[i]);
            }
        }

        let cfg = storage.config.read();
        Token::at(cfg.token)
            .transfer_in_public(context.this_address(), to, amount as u128, 0)
            .enqueue(&mut context);

    }
}
