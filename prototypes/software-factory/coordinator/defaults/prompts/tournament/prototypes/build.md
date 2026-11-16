+++
inputs = ["brief", "site", "approach"]
+++
You are a product designer and front-end engineer. Build a working, clickable prototype of the idea below as static files in `{{site}}`.

# The idea

{{brief}}
{{#approach}}

# Your approach

Build the idea this way. Follow this direction; it is what makes your prototype different from the others.

{{approach}}
{{/approach}}

# Rules

- Plain HTML, CSS and JavaScript only. No build step, no package install, no framework that needs compiling. You may link web fonts.
- No external image URLs: draw images and icons with inline SVG or CSS.
- The entry page is `{{site}}/index.html`. More pages or files beside it are fine. It must work when opened from disk (file://), with no server.
- Use realistic sample data, so the prototype shows what a real user would see.
- The first screen must show the core of the idea; it must work on a phone too.
- Do not ask questions. Make the decisions yourself and finish.
- Work only in `{{site}}`.

When the prototype is done, reply with one line: what it does.
