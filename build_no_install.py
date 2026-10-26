import base64, sys, os
os.chdir(os.path.dirname(os.path.abspath(__file__)))
T=os.path.join("..", "training", "images") + "/"
NM=os.path.join("..", "node_modules") + "/"  # run npm install in the parent folder first
ocr=open("ocr-local.js").read()
for k,f in {"LIB":"tesseract.js/dist/tesseract.min.js","WORKER":"tesseract.js/dist/worker.min.js","CORE":"tesseract.js-core/tesseract-core-simd-lstm.wasm.js","ENG":"@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz","SWA":"@tesseract.js-data/swa/4.0.0_best_int/swa.traineddata.gz"}.items():
    raw=open(NM+f,"rb").read()
    if k=="WORKER":
        # Tesseract.js 5.1.1 builds the language name from l.data instead of l.code when language data is
        # passed in directly (as here, offline). Fix that one expression; it must occur exactly once.
        bad=b'return"string"==typeof t?t:t.data}'
        assert raw.count(bad)==1, "unexpected worker.min.js build"
        raw=raw.replace(bad,b'return"string"==typeof t?t:t.code}')
    ocr=ocr.replace(f"__B64_{k}__", base64.b64encode(raw).decode())
js=ocr+"\n"+"\n".join(open(f).read() for f in ["local.js","text.js","core.js","svc.js","pages.js","workspace.js","boot.js"])
for k in ["archive_convoy","archive_notice","case_convoy","case_notice","case_patrol"]:
    js=js.replace(f"__URL_{k}__","data:image/jpeg;base64,"+base64.b64encode(open(T+k+".jpg","rb").read()).decode())
assert "</script" not in js.lower()
html=f'''<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AIVS · no-install edition</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' blob: 'wasm-unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; media-src blob: data:; connect-src data: blob:; font-src data:; frame-src blob: data: 'self'; worker-src blob:; form-action 'none'; base-uri 'none'">
<style>
{open("app.css").read()}
</style></head><body>
<div id="root"></div>
<div class="toasts" id="toasts" aria-live="polite"></div>
<script>
{js}
</script>
</body></html>
'''
out=sys.argv[1] if len(sys.argv)>1 else os.path.join("..", "AIVS (no install).html")
import os; os.makedirs(os.path.dirname(out), exist_ok=True)
open(out,"w").write(html); print(out, len(html))
