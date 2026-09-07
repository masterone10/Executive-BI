# Building the fully self-contained (offline / shareable) dashboard

The default `dashboard/index.html` loads SheetJS from a CDN. That keeps the file small,
but the **Import/Replace** feature then needs internet. For a file you can email or drop
onto a static host and that works with no internet at all, inline SheetJS.

## 1. Get SheetJS (xlsx.full.min.js)

```bash
npm pack xlsx@0.18.5
tar xzf xlsx-0.18.5.tgz
# -> package/dist/xlsx.full.min.js
```

(Any recent xlsx.full.min.js works. We pin 0.18.5.)

## 2. Build the standalone file

```bash
python engine/build_dashboard.py --standalone package/dist/xlsx.full.min.js
# -> dashboard/index_standalone.html   (~1.2 MB, zero external dependencies)
```

The build embeds the library **as base64** and decodes it at runtime:

```js
var bin = atob(b64), bytes = new Uint8Array(bin.length);
for (var i=0;i<bin.length;i++) bytes[i]=bin.charCodeAt(i);
var code = new TextDecoder("utf-8").decode(bytes);
(0,eval)(code);            // defines window.XLSX
```

Why base64 and not just pasting the JS between `<script>` tags? The minified library
contains byte sequences and `</script`-like fragments that can break naive inlining or
a templating `re.sub`. Base64 is inert text, so it always survives.

## 3. Verify it's really standalone

Open it in a browser with the network disconnected (or block `*cloudflare*`). The pages
must render and `typeof XLSX` must be `"function"`. Then use Import/Replace on a log file
— all numbers should update offline.

## Sharing

- **Send the file**: email / WhatsApp / Slack; recipient opens it in any browser.
- **Publish a link (free)**: drag onto https://app.netlify.com/drop, or
  https://tiiny.host (supports a password), or GitHub Pages for a permanent link.
- A published link is **public**; the data contains employee names, so prefer sending the
  file directly or using a password-protected host if it's sensitive.
