use dep::aztec::{
    context::PrivateContext,
    keys::getters::{get_nsk_app, get_public_keys},
    macros::notes::custom_note,
    messages::logs::note,
    note::note_interface::{NoteHash, NoteType},
    oracle::random::random,
    protocol_types::{
        address::AztecAddress,
        constants::{GENERATOR_INDEX__NOTE_HASH, GENERATOR_INDEX__NOTE_NULLIFIER},
        hash::poseidon2_hash_with_separator,
        traits::{Deserialize, Hash, Packable, Serialize},
        utils::arrays::array_concat,
    },
};

/// A private note representing a custody balance associated with an account and custody ID.
#[custom_note]
#[derive(Eq, Serialize)]
pub struct CustodyNote {
    /// The owner of the note, i.e. the account whose nullifier secret key is required to compute the nullifier.
    owner: AztecAddress,
    /// Random value, protects against note hash preimage attacks.
    randomness: Field,
    /// The ID of the custody under which this balance is held.
    custody_id: Field,
    /// The amount of tokens held in custody.
    amount: u128,
}

impl NoteHash for CustodyNote {
    fn compute_note_hash(self, storage_slot: Field) -> Field {
        poseidon2_hash_with_separator(
            array_concat(self.pack(), [storage_slot]),
            GENERATOR_INDEX__NOTE_HASH,
        )
    }

    fn compute_nullifier(
        self,
        context: &mut PrivateContext,
        note_hash_for_nullify: Field,
    ) -> Field {
        let owner_npk_m = get_public_keys(self.owner).npk_m;
        let owner_npk_m_hash = owner_npk_m.hash();
        let secret = context.request_nsk_app(owner_npk_m_hash);
        poseidon2_hash_with_separator(
            [note_hash_for_nullify, secret],
            GENERATOR_INDEX__NOTE_NULLIFIER,
        )
    }

    unconstrained fn compute_nullifier_unconstrained(self, note_hash_for_nullify: Field) -> Field {
        let owner_npk_m = get_public_keys(self.owner).npk_m;
        let owner_npk_m_hash = owner_npk_m.hash();
        let secret = get_nsk_app(owner_npk_m_hash);
        poseidon2_hash_with_separator(
            [note_hash_for_nullify, secret],
            GENERATOR_INDEX__NOTE_NULLIFIER,
        )
    }
}

impl CustodyNote {
    pub fn new(custody_id: Field, amount: u128, owner: AztecAddress) -> Self {
        let randomness = unsafe { random() };
        Self { owner, randomness, custody_id, amount }
    }

    pub fn get_custody_id(self) -> Field {
        self.custody_id
    }

    pub fn get_amount(self) -> u128 {
        self.amount
    }
}
