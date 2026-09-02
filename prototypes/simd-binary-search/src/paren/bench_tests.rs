//! Crate-internal benchmark seam for the parenthesis matcher.
//!
//! The vector kernels are private seams of `super`, and a `benches/` target is a
//! separate crate that cannot reach them, so the comparison lives inside the
//! crate. It is a `#[test]` marked `#[ignore]`, so the default suite stays fast
//! and the measurement is taken on request:
//!
//! ```text
//! cargo test --release --lib -- --ignored --nocapture
//! ```
//!
//! Only timings are produced here: no production behavior changes, no public
//! item is added, and every call into a target-feature kernel is guarded by the
//! same runtime detection the dispatcher uses.

use std::hint::black_box;
use std::time::{Duration, Instant};

use super::ParenScan;
use super::scalar;

const OPEN: u8 = b'(';
const CLOSE: u8 = b')';

/// Corpus size in bytes. Four mebibytes is far past every cache level on a
/// normal machine, so each timed scan travels a long distance through memory
/// rather than re-reading a resident block.
const CORPUS_LENGTH: usize = 4 * 1024 * 1024;

/// Timed repetitions per backend and corpus. Enough repetitions to swamp the
/// clock's resolution, few enough that the ignored benchmark stays short.
const ITERATIONS: usize = 50;

/// Fixed-seed linear congruential generator, the same one the backend tests
/// use, so every corpus is byte-identical on every run and every machine.
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

    /// An ordinary data byte: never `(` and never `)`, so it never moves the
    /// depth counter.
    fn ordinary_byte(&mut self) -> u8 {
        b'a' + (self.next_u32() % 26) as u8
    }
}

/// A generated input together with the answer every timed scan must produce.
struct Corpus {
    name: &'static str,
    bytes: Vec<u8>,
    open_index: usize,
    match_index: usize,
}

/// Parentheses are rare among ordinary bytes, so most vector blocks carry no
/// parenthesis at all and can be skipped whole. The open parenthesis under test
/// sits at index 0 and its match is the last byte, so a scan crosses the whole
/// corpus. Every interior pair is balanced, so the depth never reaches zero
/// early.
fn sparse_corpus() -> Corpus {
    let mut generator = Lcg::new(0x5EED_0000_5A5E_D000);
    let mut bytes = Vec::with_capacity(CORPUS_LENGTH);
    bytes.push(OPEN);

    while bytes.len() + 1 < CORPUS_LENGTH {
        let remaining = CORPUS_LENGTH - 1 - bytes.len();

        // Roughly three parenthesis pairs per thousand bytes.
        if generator.below(1000) < 3 && remaining > 64 {
            let inner = generator.below(48) as usize;
            bytes.push(OPEN);
            for _ in 0..inner {
                let byte = generator.ordinary_byte();
                bytes.push(byte);
            }
            bytes.push(CLOSE);
        } else {
            let byte = generator.ordinary_byte();
            bytes.push(byte);
        }
    }

    bytes.push(CLOSE);
    assert_eq!(bytes.len(), CORPUS_LENGTH);

    Corpus {
        name: "sparse",
        open_index: 0,
        match_index: CORPUS_LENGTH - 1,
        bytes,
    }
}

/// Parentheses are frequent and deeply nested, so nearly every vector block has
/// to be resolved lane by lane. The open parenthesis under test sits at index 0
/// and its match is the last byte, so a scan crosses the whole corpus.
fn dense_corpus() -> Corpus {
    /// Deepest interior nesting the walk is allowed to reach.
    const MAX_DEPTH: usize = 512;

    let mut generator = Lcg::new(0x0DE5_5EC0_DE12_3456);
    let mut bytes = Vec::with_capacity(CORPUS_LENGTH);
    bytes.push(OPEN);

    // Interior open parentheses still waiting for their close. Every one of
    // them is closed before the final close paren, so the depth stays above
    // zero until the last byte.
    let mut open_stack: usize = 0;

    // One byte is reserved for the final close paren, and one for each interior
    // open still on the stack, plus room for one more open.
    while bytes.len() + open_stack + 3 <= CORPUS_LENGTH {
        let roll = generator.below(100);

        if roll < 45 && open_stack > 0 {
            bytes.push(CLOSE);
            open_stack -= 1;
        } else if roll < 92 && open_stack < MAX_DEPTH {
            bytes.push(OPEN);
            open_stack += 1;
        } else {
            let byte = generator.ordinary_byte();
            bytes.push(byte);
        }
    }

    // At most two bytes of padding, so the corpus lands on an exact length.
    while bytes.len() + open_stack + 1 < CORPUS_LENGTH {
        let byte = generator.ordinary_byte();
        bytes.push(byte);
    }

    while open_stack > 0 {
        bytes.push(CLOSE);
        open_stack -= 1;
    }

    bytes.push(CLOSE);
    assert_eq!(bytes.len(), CORPUS_LENGTH);

    Corpus {
        name: "dense",
        open_index: 0,
        match_index: CORPUS_LENGTH - 1,
        bytes,
    }
}

/// What one backend produced over the whole timed run.
struct Measurement {
    elapsed: Duration,
    /// Sum of the per-iteration match indexes. Two backends agree exactly when
    /// their checksums agree; `vector_steps` is never folded in here, because
    /// it is a claim about how the answer was computed, not about the answer.
    index_checksum: usize,
    /// Sum of the per-iteration vector step counts. Zero for the scalar kernel,
    /// positive for a vector kernel that really did vectorize.
    vector_steps: usize,
}

/// Runs `kernel` over `corpus` `ITERATIONS` times and reports the elapsed time
/// together with the two accumulators.
///
/// The input goes through `black_box` inside every iteration, so the optimizer
/// cannot hoist the call out of the loop, and both accumulators are
/// black-boxed, so it cannot delete the work as unused.
fn measure(corpus: &Corpus, kernel: fn(&[u8], usize) -> ParenScan) -> Measurement {
    let mut index_checksum: usize = 0;
    let mut vector_steps: usize = 0;

    let start = Instant::now();
    for _ in 0..ITERATIONS {
        let input = black_box(corpus.bytes.as_slice());
        let scan = kernel(input, black_box(corpus.open_index));

        // A missing match would be a bug in the corpus, not a plausible index,
        // so it is folded in as a value no real index can take.
        let index = black_box(scan.index.unwrap_or(usize::MAX));
        index_checksum = black_box(index_checksum.wrapping_add(index));

        let steps = black_box(scan.vector_steps);
        vector_steps = black_box(vector_steps.wrapping_add(steps));
    }
    let elapsed = start.elapsed();

    Measurement {
        elapsed,
        index_checksum,
        vector_steps,
    }
}

/// Bytes travelled per second, in mebibytes, over the whole timed run.
fn throughput_mib_per_second(corpus: &Corpus, elapsed: Duration) -> f64 {
    let bytes = (corpus.bytes.len() * ITERATIONS) as f64;
    bytes / (1024.0 * 1024.0) / elapsed.as_secs_f64()
}

fn report(corpus: &Corpus, backend: &str, run: &Measurement, scalar: Option<&Measurement>) {
    let seconds = run.elapsed.as_secs_f64();
    let throughput = throughput_mib_per_second(corpus, run.elapsed);

    let ratio = match scalar {
        Some(scalar) => format!(
            ", {:.2}x scalar",
            scalar.elapsed.as_secs_f64() / seconds.max(f64::MIN_POSITIVE),
        ),
        None => String::new(),
    };

    println!(
        "  {backend:>6}: {seconds:.4} s, {throughput:.1} MiB/s, \
         {} vector steps{ratio}",
        run.vector_steps,
    );
}

/// Times every backend reachable on this machine against one corpus.
fn benchmark_corpus(corpus: &Corpus) {
    // The corpus, not the kernel, is what makes each scan travel far: check the
    // answer once outside the timed loops.
    let check = scalar::scan(&corpus.bytes, corpus.open_index);
    assert_eq!(check.index, Some(corpus.match_index));

    println!(
        "\nparen backend benchmark: {} corpus, {} bytes, open at {}, \
         match at {}, {ITERATIONS} iterations",
        corpus.name,
        corpus.bytes.len(),
        corpus.open_index,
        corpus.match_index,
    );

    let scalar = measure(corpus, scalar::scan);
    report(corpus, "scalar", &scalar, None);
    assert_eq!(
        scalar.vector_steps, 0,
        "the scalar kernel is not vectorized, so it must report no vector step"
    );

    #[cfg(target_arch = "aarch64")]
    {
        if super::neon::is_supported() {
            let neon = measure(corpus, super::neon::scan);
            report(corpus, "neon", &neon, Some(&scalar));

            assert_eq!(
                neon.index_checksum, scalar.index_checksum,
                "neon and scalar disagree on the {} corpus",
                corpus.name
            );
            assert!(
                neon.vector_steps > 0,
                "the neon kernel ran no vector step on the {} corpus",
                corpus.name
            );
        } else {
            println!("    neon: not supported on this machine, not measured");
        }
    }

    #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
    {
        if super::avx2::is_supported() {
            let avx2 = measure(corpus, super::avx2::scan);
            report(corpus, "avx2", &avx2, Some(&scalar));

            assert_eq!(
                avx2.index_checksum, scalar.index_checksum,
                "avx2 and scalar disagree on the {} corpus",
                corpus.name
            );
            assert!(
                avx2.vector_steps > 0,
                "the avx2 kernel ran no vector step on the {} corpus",
                corpus.name
            );
        } else {
            println!("    avx2: not supported on this machine, not measured");
        }
    }
}

/// Ignored by default: this is a measurement, not a correctness check, and it
/// is only meaningful in a release build.
#[test]
#[ignore = "benchmark: cargo test --release --lib -- --ignored --nocapture"]
fn the_paren_backends_are_benchmarked_against_each_other() {
    benchmark_corpus(&sparse_corpus());
    benchmark_corpus(&dense_corpus());
}
