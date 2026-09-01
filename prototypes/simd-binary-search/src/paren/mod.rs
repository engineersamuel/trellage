use crate::search::Backend;

mod scalar;

#[cfg(test)]
mod backend_tests;

/// Outcome of a single backend scan for a matching close parenthesis.
pub(crate) struct ParenScan {
    /// Index of the matching close parenthesis, when one exists.
    pub index: Option<usize>,
    /// Number of vector steps the backend executed. The portable scalar kernel
    /// always reports zero; vector backends report their block count.
    #[allow(dead_code)]
    pub vector_steps: usize,
}

/// Picks the kernel to run for the current machine. Only the portable scalar
/// kernel exists so far, so every detected backend maps onto it.
pub(crate) fn detect() -> Backend {
    Backend::Scalar
}

/// Returns the index of the close parenthesis matching the open parenthesis at
/// `open_index`.
///
/// Returns `None` when `open_index` is out of bounds, when the byte at
/// `open_index` is not `(`, or when no matching close parenthesis exists. Every
/// byte other than `(` and `)` is ordinary data: there is no string, escape, or
/// comment parsing.
pub fn find_matching_paren(input: &[u8], open_index: usize) -> Option<usize> {
    let scan = match detect() {
        Backend::Neon | Backend::Avx2 | Backend::Scalar => scalar::scan(input, open_index),
    };

    scan.index
}
