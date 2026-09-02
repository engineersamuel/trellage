use crate::search::Backend;

#[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
mod avx2;
#[cfg(target_arch = "aarch64")]
mod neon;
mod scalar;

#[cfg(test)]
mod backend_tests;

/// Outcome of a single backend scan for a matching close parenthesis.
pub(crate) struct ParenScan {
    /// Index of the matching close parenthesis, when one exists.
    pub index: Option<usize>,
    /// Number of vector steps the backend executed. The portable scalar kernel
    /// always reports zero; vector backends report their block count. The
    /// dispatcher checks it against the input length, and the crate-internal
    /// backend tests assert that the vector kernels really do vectorize.
    pub vector_steps: usize,
}

/// Picks the kernel to run for the current machine: the AArch64 NEON kernel
/// when this build targets aarch64 and the machine reports NEON support, the
/// AVX2 kernel when this build targets x86 or x86_64 and the machine reports
/// AVX2 support, and the portable scalar kernel otherwise.
pub(crate) fn detect() -> Backend {
    #[cfg(target_arch = "aarch64")]
    {
        if neon::is_supported() {
            return Backend::Neon;
        }
    }
    #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
    {
        if avx2::is_supported() {
            return Backend::Avx2;
        }
    }
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
        #[cfg(target_arch = "aarch64")]
        Backend::Neon => neon::scan(input, open_index),
        #[cfg(not(target_arch = "aarch64"))]
        Backend::Neon => scalar::scan(input, open_index),
        #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
        Backend::Avx2 => avx2::scan(input, open_index),
        #[cfg(not(any(target_arch = "x86", target_arch = "x86_64")))]
        Backend::Avx2 => scalar::scan(input, open_index),
        Backend::Scalar => scalar::scan(input, open_index),
    };

    // A vector step consumes a whole block of input bytes, so no kernel can
    // report more steps than the input has bytes. Checked in debug builds to
    // catch a kernel that miscounts the blocks it consumed.
    debug_assert!(scan.vector_steps <= input.len());

    scan.index
}
