# Third-party test fixtures

`firstmate/<commit>/` holds verbatim copies of the exact upstream Firstmate
files the pinned `fmx` overlay edits, taken from
<https://github.com/kunchenguid/firstmate> at the commit named by the directory.

They exist so the checked-in overlay can be proved offline: the contract test
stages them through a fake `git`, verifies the recorded base digests, applies
the real patches, and verifies the recorded result digests. Nothing here is
executed as part of the Trellage product.

Do not edit these files. They must stay byte-identical to upstream, or the
overlay base digests in `overlay/<commit>/manifest.json` stop matching.

Firstmate is MIT licensed:

```
MIT License

Copyright (c) 2026 Kun Chen

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
