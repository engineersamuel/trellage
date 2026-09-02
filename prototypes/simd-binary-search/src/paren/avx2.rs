//! AVX2 kernel for the parenthesis matcher.
//!
//! The scan keeps the scalar depth counter of `super::scalar` and only replaces
//! the byte inspection: each 32-byte block is compared against `(` and `)` in
//! one vector step, and blocks that carry no parenthesis at all are skipped
//! without touching the depth counter. Blocks that do carry a parenthesis are
//! resolved in ascending bit order, which is ascending byte order, so the first
//! close parenthesis that drives the depth to zero is the one reported.
//!
//! One kernel serves both x86 and x86_64: the intrinsics live in a different
//! module on each, so only the import differs.

#[cfg(target_arch = "x86")]
use std::arch::x86::{
    __m256i, _mm256_cmpeq_epi8, _mm256_loadu_si256, _mm256_movemask_epi8, _mm256_set1_epi8,
};
#[cfg(target_arch = "x86_64")]
use std::arch::x86_64::{
    __m256i, _mm256_cmpeq_epi8, _mm256_loadu_si256, _mm256_movemask_epi8, _mm256_set1_epi8,
};

use super::ParenScan;

const OPEN: u8 = b'(';
const CLOSE: u8 = b')';

/// Vector block width in bytes: one full 256-bit AVX2 register of `u8` lanes.
const BLOCK: usize = 32;

pub(super) fn is_supported() -> bool {
    std::arch::is_x86_feature_detected!("avx2")
}

/// Returns the index of the close parenthesis matching the open parenthesis at
/// `open_index`, along with the number of vector blocks the kernel consumed.
///
/// Returns `None` when `open_index` is out of bounds, when the byte at
/// `open_index` is not `(`, or when no matching close parenthesis exists.
pub(crate) fn scan(input: &[u8], open_index: usize) -> ParenScan {
    assert!(is_supported(), "the avx2 kernel requires avx2 support");

    // SAFETY: `is_supported` returned true immediately above, so the `avx2`
    // target feature enabled on `scan_avx2` is present on this machine.
    unsafe { scan_avx2(input, open_index) }
}

#[target_feature(enable = "avx2")]
unsafe fn scan_avx2(input: &[u8], open_index: usize) -> ParenScan {
    if input.get(open_index) != Some(&OPEN) {
        return ParenScan {
            index: None,
            vector_steps: 0,
        };
    }

    // `open_index` indexes a byte of `input`, so it is smaller than
    // `input.len()` and the increment below cannot overflow.
    let mut position = open_index + 1;
    let mut depth: usize = 1;
    let mut vector_steps = 0;

    let opens = _mm256_set1_epi8(OPEN as i8);
    let closes = _mm256_set1_epi8(CLOSE as i8);

    // Whole blocks only: a block is entered exactly when 32 bytes remain, so
    // every load is full width and fully in bounds.
    while position + BLOCK <= input.len() {
        // SAFETY: the loop condition guarantees `position + 32 <= input.len()`,
        // so the 32 bytes read from `input.as_ptr().add(position)` all lie
        // inside the slice's allocation, and `_mm256_loadu_si256` is the
        // unaligned load, so it needs no alignment beyond that of `u8`.
        let block = unsafe { _mm256_loadu_si256(input.as_ptr().add(position).cast::<__m256i>()) };
        let open_mask = _mm256_movemask_epi8(_mm256_cmpeq_epi8(block, opens)) as u32;
        let close_mask = _mm256_movemask_epi8(_mm256_cmpeq_epi8(block, closes)) as u32;
        vector_steps += 1;

        // Bit `n` of a mask stands for byte `n` of the block, so consuming the
        // union from the lowest set bit upwards visits the parentheses in
        // source order. The union is zero exactly when the block carries no
        // parenthesis, which leaves the depth untouched and skips the block
        // whole. A byte is never both an open and a close parenthesis, so the
        // two masks never share a bit.
        let mut pending = open_mask | close_mask;
        while pending != 0 {
            let lane = pending.trailing_zeros() as usize;

            if open_mask & (1 << lane) != 0 {
                depth += 1;
            } else {
                depth -= 1;
                if depth == 0 {
                    return ParenScan {
                        index: Some(position + lane),
                        vector_steps,
                    };
                }
            }

            // Clears the lowest set bit, so the next iteration takes the next
            // parenthesis in ascending byte order.
            pending &= pending - 1;
        }

        position += BLOCK;
    }

    // Fewer than 32 bytes remain, so the tail is finished one byte at a time.
    while position < input.len() {
        match input[position] {
            OPEN => depth += 1,
            CLOSE => {
                depth -= 1;
                if depth == 0 {
                    return ParenScan {
                        index: Some(position),
                        vector_steps,
                    };
                }
            }
            _ => {}
        }
        position += 1;
    }

    ParenScan {
        index: None,
        vector_steps,
    }
}
