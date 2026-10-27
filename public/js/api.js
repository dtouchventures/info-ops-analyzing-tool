// API client. Every state-changing call carries the X-AIVS header (CSRF defence) and session cookie.
export class ApiError extends Error { constructor(status, message, details) { super(message); this.status = status; this.details = details; } }
async function call(method, url, body, { raw } = {}) {
  const opts = { method, headers: { "x-aivs": "1" }, credentials: "same-origin" };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers["content-type"] = "application/json"; }
  let res;
  try { res = await fetch(url, opts); } catch { throw new ApiError(0, "Cannot reach the AIVS server. Check the connection and try again."); }
  if (raw) return res;
  const ct = res.headers.get("content-type") || "", data = ct.includes("json") ? await res.json() : await res.text();
  if (!res.ok) {
    if (res.status === 401 && !url.includes("/auth/")) { window.dispatchEvent(new CustomEvent("aivs:signedout")); }
    throw new ApiError(res.status, data?.error || `Request failed (${res.status}).`, data?.details);
  }
  return data;
}
export const api = {
  get: u => call("GET", u), post: (u, b = {}) => call("POST", u, b), patch: (u, b) => call("PATCH", u, b), put: (u, b) => call("PUT", u, b), del: u => call("DELETE", u),
  // multipart upload with progress (XHR gives upload progress events; fetch does not)
  upload(url, form, onProgress) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest(); x.open("POST", url); x.setRequestHeader("x-aivs", "1");
      x.upload.onprogress = e => e.lengthComputable && onProgress?.(e.loaded / e.total);
      x.onload = () => { let d; try { d = JSON.parse(x.responseText); } catch { d = {}; } x.status < 300 ? resolve(d) : reject(new ApiError(x.status, d.error || (d.errors || []).join(" ") || `Upload failed (${x.status}).`, d.details || d.errors)); };
      x.onerror = () => reject(new ApiError(0, "Upload interrupted. Check the connection and try again."));
      x.send(form);
    });
  }
};
