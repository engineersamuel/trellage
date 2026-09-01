use super::scalar;

const OPEN: u8 = b'(';
const CLOSE: u8 = b')';

/// Independent, obviously correct model of the contract, kept deliberately
/// naive so it cannot share a bug with the kernel under test.
fn naive_matching_paren(input: &[u8], open_index: usize) -> Option<usize> {
    if input.get(open_index) != Some(&OPEN) {
        return None;
    }

    let mut depth: usize = 0;
    for (offset, byte) in input.iter().enumerate().skip(open_index) {
        if *byte == OPEN {
            depth += 1;
        } else if *byte == CLOSE {
            depth -= 1;
            if depth == 0 {
                return Some(offset);
            }
        }
    }

    None
}

fn assert_matches_reference(input: &[u8], open_index: usize) {
    let scan = scalar::scan(input, open_index);
    let expected = naive_matching_paren(input, open_index);

    assert_eq!(scan.index, expected, "index {open_index} in {input:?}");
    assert_eq!(scan.vector_steps, 0, "scalar kernel is not vectorized");
}

fn assert_every_index_matches_reference(input: &[u8]) {
    let past_the_end = input.len() + 1;

    for open_index in 0..=past_the_end {
        assert_matches_reference(input, open_index);
    }
}

#[test]
fn the_scalar_kernel_matches_the_reference_on_handwritten_inputs() {
    assert_every_index_matches_reference(b"");
    assert_every_index_matches_reference(b"(");
    assert_every_index_matches_reference(b"()");
    assert_every_index_matches_reference(b"((()))");
    assert_every_index_matches_reference(b"(()())");
    assert_every_index_matches_reference(b"a()b");
    assert_every_index_matches_reference(b"(((");
    assert_every_index_matches_reference(b"())))");
    assert_every_index_matches_reference(b"(xxxxxxxxxxxxxxxx)");
    assert_every_index_matches_reference(br#"("\)" ; )"#);
}

#[test]
fn the_scalar_kernel_matches_the_reference_around_the_vector_boundaries() {
    for boundary in [16usize, 32, 64] {
        let shortest = boundary - 2;
        let longest = boundary + 2;

        for length in shortest..=longest {
            let mut input = vec![OPEN];
            input.extend(std::iter::repeat_n(b'x', length));
            input.push(CLOSE);

            assert_matches_reference(&input, 0);
        }
    }
}

/// Fixed-seed linear congruential generator so generated cases are identical on
/// every run and every machine.
struct Lcg {
    state: u64,
}

impl Lcg {
    fn new(seed: u64) -> Self {
        Self { state: seed }
    }

    fn next_u32(&mut self) -> u32 {
        let stepped = self.state.wrapping_mul(6_364_136_223_846_793_005);
        self.state = stepped.wrapping_add(1_442_695_040_888_963_407);
        (self.state >> 33) as u32
    }

    fn below(&mut self, bound: u32) -> u32 {
        self.next_u32() % bound
    }
}

#[test]
fn the_scalar_kernel_matches_the_reference_on_generated_inputs() {
    let mut generator = Lcg::new(0x1234_5678_9ABC_DEF0);

    for _ in 0..200 {
        let length = generator.below(200) as usize;
        let open_weight = 5 + generator.below(40);
        let mut input = Vec::with_capacity(length);

        for _ in 0..length {
            let roll = generator.below(100);
            if roll < open_weight {
                input.push(OPEN);
            } else if roll < 2 * open_weight {
                input.push(CLOSE);
            } else {
                input.push(b'a' + (roll % 26) as u8);
            }
        }

        for open_index in 0..=input.len() {
            assert_matches_reference(&input, open_index);
        }
    }
}
