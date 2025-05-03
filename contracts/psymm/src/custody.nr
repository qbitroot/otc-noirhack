use dep::aztec::{
    context::PrivateContext,
    messages::logs::note::encode_and_encrypt_note,
    note::{
        retrieved_note::RetrievedNote,
        note_getter_options::NoteGetterOptions,
    },
    state_vars::{PrivateSet, storage::Storage},
    macros::notes::note,
    oracle::random::random,
    protocol_types::{
        address::AztecAddress,
        constants::MAX_NOTE_HASH_READ_REQUESTS_PER_CALL,
        utils::field::full_field_less_than,
    },
};



#[note]
#[derive(Eq)]
pub struct DepositNote {
    deposit_owner: AztecAddress,
    deposit_amount: Field,
    owner: AztecAddress, // for decryption
    randomness: Field,
}
// docs:end:value-note-def

impl DepositNote {
    pub fn new(deposit_owner: AztecAddress, deposit_amount: Field, owner: AztecAddress) -> Self {
        let randomness = unsafe { random() };

        DepositNote { deposit_owner, deposit_amount, owner, randomness }
    }

    pub fn deposit_owner(self) -> AztecAddress {
        self.deposit_owner
    }
    pub fn deposit_amount(self) -> Field {
        self.deposit_amount
    }
}


pub struct Custody<Context> {
    context: Context,
    set: PrivateSet<DepositNote, Context>,
}

// TODO(#13824): remove this impl once we allow structs to hold state variables.
impl<Context> Storage<1> for Custody<Context> {
    fn get_storage_slot(self) -> Field {
        self.set.get_storage_slot()
    }
}

impl<Context> Custody<Context> {
    pub fn new(context: Context, storage_slot: Field) -> Self {
        Custody { context, set: PrivateSet::new(context, storage_slot) }
    }
}

pub struct FilterArgs {
    deposit_owner: AztecAddress,
    min_sum: Field,
}

pub fn filter_notes_min_sum(
    notes: [Option<RetrievedNote<DepositNote>>; MAX_NOTE_HASH_READ_REQUESTS_PER_CALL],
    args: FilterArgs,
) -> [Option<RetrievedNote<DepositNote>>; MAX_NOTE_HASH_READ_REQUESTS_PER_CALL] {
    let mut selected = [Option::none(); MAX_NOTE_HASH_READ_REQUESTS_PER_CALL];

    let mut sum = 0;
    for i in 0..notes.len() {
        if notes[i].is_some() & full_field_less_than(sum, args.min_sum) {
            let retrieved_note = notes[i].unwrap_unchecked();
            selected[i] = Option::some(retrieved_note);
            if retrieved_note.note.deposit_owner.eq(args.deposit_owner) {
                sum += retrieved_note.note.deposit_amount();
            }
        }
    }

    selected
}


impl Custody<&mut PrivateContext> {
    // Very similar to `value_note::utils::increment`.
    pub fn add(self, addend: u64, deposit_owner: AztecAddress, owner: AztecAddress) {
        let addend_note = DepositNote::new(deposit_owner, addend as Field, owner);

        self.set.insert(addend_note).emit(encode_and_encrypt_note(self.context, owner, owner));
    }

    // Very similar to `value_note::utils::decrement`.
    pub fn sub(self, subtrahend: u64, deposit_owner: AztecAddress, owner: AztecAddress) {
        let filter_args = FilterArgs {
            deposit_owner,
            min_sum: subtrahend as Field,
        };
        let options = NoteGetterOptions::with_filter(filter_notes_min_sum, filter_args);
        let notes = self.set.pop_notes(options);
        let mut minuend: u64 = 0;
        for i in 0..options.limit {
            if i < notes.len() {
                let note = notes.get_unchecked(i);

                minuend += note.deposit_amount() as u64;
            }
        }

        assert(minuend >= subtrahend);

        let result_value = minuend - subtrahend;
        let result_note = DepositNote::new(deposit_owner, result_value as Field, owner);
        self.set.insert(result_note).emit(encode_and_encrypt_note(self.context, owner, owner));
    }
}

