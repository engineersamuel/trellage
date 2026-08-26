mod arch;
mod search;
mod verify;

pub use search::{Backend, SearchOutcome, SortedI32, UnsortedAt};
pub use verify::{VerificationError, VerificationSummary, verify_accuracy};

pub fn selected_backend() -> Backend {
    arch::detect()
}
