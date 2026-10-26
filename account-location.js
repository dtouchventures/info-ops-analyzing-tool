// Where an account is based, as the PLATFORM itself states it, read from text in a screenshot the analyst supplied
// (OCR). Nothing is fetched, scraped or inferred. Sources recognised:
//   Facebook Page transparency: "People who manage this Page are primarily located in: Kenya", or the list
//     "Primary country/region location for people who manage this Page includes: Kenya (4), Uganda (1)"
//   Instagram "About this account": "Account based in" followed by the country
//   Facebook profile intro (self-reported by the account): "Lives in Nairobi, Kenya", "From Mombasa"
// Results are candidates for the analyst to confirm. They describe what the platform or the account says, not a
// verified location, and never where a particular post was made.

export const LOCATION_SOURCES = {
  facebook_transparency: "Facebook Page transparency (stated by Facebook)",
  instagram_about: "Instagram ‘About this account’ (stated by Instagram)",
  profile_self_reported: "Profile information (stated by the account itself)",
  other: "Other source (described in the basis)"
};

export const COUNTRIES = ["Afghanistan", "Albania", "Algeria", "Andorra", "Angola", "Antigua and Barbuda", "Argentina", "Armenia", "Australia", "Austria", "Azerbaijan", "Bahamas", "Bahrain", "Bangladesh", "Barbados", "Belarus", "Belgium", "Belize", "Benin", "Bhutan", "Bolivia", "Bosnia and Herzegovina", "Botswana", "Brazil", "Brunei", "Bulgaria", "Burkina Faso", "Burundi", "Cabo Verde", "Cambodia", "Cameroon", "Canada", "Central African Republic", "Chad", "Chile", "China", "Colombia", "Comoros", "Congo", "Democratic Republic of the Congo", "Costa Rica", "Côte d'Ivoire", "Croatia", "Cuba", "Cyprus", "Czechia", "Denmark", "Djibouti", "Dominica", "Dominican Republic", "Ecuador", "Egypt", "El Salvador", "Equatorial Guinea", "Eritrea", "Estonia", "Eswatini", "Ethiopia", "Fiji", "Finland", "France", "Gabon", "Gambia", "Georgia", "Germany", "Ghana", "Greece", "Grenada", "Guatemala", "Guinea", "Guinea-Bissau", "Guyana", "Haiti", "Honduras", "Hong Kong", "Hungary", "Iceland", "India", "Indonesia", "Iran", "Iraq", "Ireland", "Israel", "Italy", "Jamaica", "Japan", "Jordan", "Kazakhstan", "Kenya", "Kiribati", "Kosovo", "Kuwait", "Kyrgyzstan", "Laos", "Latvia", "Lebanon", "Lesotho", "Liberia", "Libya", "Liechtenstein", "Lithuania", "Luxembourg", "Madagascar", "Malawi", "Malaysia", "Maldives", "Mali", "Malta", "Marshall Islands", "Mauritania", "Mauritius", "Mexico", "Micronesia", "Moldova", "Monaco", "Mongolia", "Montenegro", "Morocco", "Mozambique", "Myanmar", "Namibia", "Nauru", "Nepal", "Netherlands", "New Zealand", "Nicaragua", "Niger", "Nigeria", "North Korea", "North Macedonia", "Norway", "Oman", "Pakistan", "Palau", "Palestine", "Panama", "Papua New Guinea", "Paraguay", "Peru", "Philippines", "Poland", "Portugal", "Qatar", "Romania", "Russia", "Rwanda", "Saint Kitts and Nevis", "Saint Lucia", "Saint Vincent and the Grenadines", "Samoa", "San Marino", "São Tomé and Príncipe", "Saudi Arabia", "Senegal", "Serbia", "Seychelles", "Sierra Leone", "Singapore", "Slovakia", "Slovenia", "Solomon Islands", "Somalia", "South Africa", "South Korea", "South Sudan", "Spain", "Sri Lanka", "Sudan", "Suriname", "Sweden", "Switzerland", "Syria", "Taiwan", "Tajikistan", "Tanzania", "Thailand", "Timor-Leste", "Togo", "Tonga", "Trinidad and Tobago", "Tunisia", "Türkiye", "Turkmenistan", "Tuvalu", "Uganda", "Ukraine", "United Arab Emirates", "United Kingdom", "United States", "Uruguay", "Uzbekistan", "Vanuatu", "Venezuela", "Vietnam", "Yemen", "Zambia", "Zimbabwe"];
const ALIAS = { "usa": "United States", "united states of america": "United States", "us": "United States", "uk": "United Kingdom", "great britain": "United Kingdom", "uae": "United Arab Emirates", "drc": "Democratic Republic of the Congo", "dr congo": "Democratic Republic of the Congo", "congo (drc)": "Democratic Republic of the Congo", "turkey": "Türkiye", "ivory coast": "Côte d'Ivoire", "cote d'ivoire": "Côte d'Ivoire", "czech republic": "Czechia", "swaziland": "Eswatini", "burma": "Myanmar", "russian federation": "Russia", "republic of korea": "South Korea", "korea": "South Korea" };
const fold = s => String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[’`]/g, "'").replace(/\s+/g, " ").trim();
const BY = new Map(COUNTRIES.map(c => [fold(c), c]));
export function country(s) { const k = fold(s).replace(/[.,;:]+$/, ""); return BY.get(k) || ALIAS[k] || null; }
const clean = s => String(s || "").replace(/[|•·]+/g, " ").replace(/\s+/g, " ").replace(/^[\s:.,-]+|[\s:.,;-]+$/g, "").trim();

export function detectAccountLocation(text) {
  const t = String(text || "").replace(/\r/g, ""), out = [], seen = new Set();
  const add = (location, source, quote) => {
    const loc = clean(location).slice(0, 120); if (loc.length < 2) return;
    const c = country(loc) || (loc.includes(",") ? country(loc.split(",").pop()) : null), key = `${source}|${fold(loc)}`; if (seen.has(key)) return; seen.add(key);
    out.push({ location: c && source !== "profile_self_reported" ? c : loc, country: c, recognised: !!c, source, quote: clean(quote).slice(0, 240) });
  };
  // Facebook: list with counts under "Primary country/region location for people who manage this Page"
  for (const m of t.matchAll(/(primary\s+country(?:\/region)?\s+locations?\s+for\s+(?:the\s+)?people\s+who\s+manage\s+this\s+(?:page|profile)[^:\n]*:?)([\s\S]{0,400})/gi)) {
    const items = [...m[2].matchAll(/([A-Za-zÀ-ÿ'’.\- ]{2,50}?)\s*\((\d+)\)/g)];
    if (items.length) for (const it of items) add(it[1], "facebook_transparency", `${m[1]} ${it[1].trim()} (${it[2]})`);
    else { const first = m[2].split("\n").map(clean).find(Boolean); if (first) add(first, "facebook_transparency", `${m[1]} ${first}`); }
  }
  for (const m of t.matchAll(/((?:people who manage this (?:page|profile)|page managers?) (?:are|is) primarily located in)\s*:?\s*\n?\s*([^\n.]{2,80})/gi)) add(m[2], "facebook_transparency", `${m[1]} ${m[2]}`);
  // Instagram: "Account based in" then the country, on the same line or the next
  for (const m of t.matchAll(/(account based in)\s*:?\s*\n?\s*([^\n]{2,60})/gi)) add(m[2], "instagram_about", `${m[1]} ${m[2]}`);
  // Facebook profile intro: self-reported
  for (const m of t.matchAll(/^\s*((?:lives in|from|anaishi|kutoka)\s+)([A-ZÀ-Ý][^\n]{1,80})$/gim)) add(m[2], "profile_self_reported", `${m[1]}${m[2]}`);
  return out;
}
