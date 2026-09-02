use super::ParenScan;

const OPEN: u8 = b'(';
const CLOSE: u8 = b')';

/// Portable reference kernel: one byte at a time, no vector steps.
pub(crate) fn scan(input: &[u8], open_index: usize) -> ParenScan {
    ParenScan {
        index: matching_index(input, open_index),
        vector_steps: 0,
    }
}

fn matching_index(input: &[u8], open_index: usize) -> Option<usize> {
    if input.get(open_index) != Some(&OPEN) {
        return None;
    }

    let mut depth: usize = 1;
    for (offset, byte) in input.iter().enumerate().skip(open_index + 1) {
        match *byte {
            OPEN => depth += 1,
            CLOSE => {
                depth -= 1;
                if depth == 0 {
                    return Some(offset);
                }
            }
            _ => {}
        }
    }

    None
}
