// Télécharge toutes les friperies de France métropolitaine (et des zones frontalières
// couvertes par le rectangle) depuis OpenStreetMap, dans data/friperies.json.
// À relancer de temps en temps pour rafraîchir les données : node tools/update-data.js
const fs = require("fs");
const path = require("path");

// Sud, Ouest, Nord, Est — doit rester identique à DATASET_BBOX dans app.js.
const BBOX = [41.3, -5.3, 51.2, 9.7];
const OUT = path.join(__dirname, "..", "data", "friperies.json");
const ENDPOINT = "https://overpass-api.de/api/interpreter";

const query = `[out:json][timeout:300][bbox:${BBOX.join(",")}];
(
  nwr["shop"="second_hand"];
  nwr["shop"="charity"];
  nwr["shop"="vintage"];
  nwr["shop"="clothes"]["second_hand"~"^(yes|only)$"];
);
out center tags;`;

// Même logique que toShop() dans app.js, en format compact (tableau) pour alléger le fichier.
function categorize(t) {
  if (t.shop === "charity") return "s";
  if (t.shop === "clothes") return "v";
  return "f";
}

function compact(el) {
  const t = el.tags || {};
  const lat = el.lat ?? el.center?.lat;
  const lon = el.lon ?? el.center?.lon;
  if (lat == null || lon == null) return null;
  const address = [
    [t["addr:housenumber"], t["addr:street"]].filter(Boolean).join(" "),
    [t["addr:postcode"], t["addr:city"]].filter(Boolean).join(" "),
  ].filter(Boolean).join(", ");
  const row = [
    el.type[0] + el.id,
    Math.round(lat * 1e5) / 1e5,
    Math.round(lon * 1e5) / 1e5,
    t.name || t.brand || "",
    categorize(t),
    address,
    t.opening_hours || "",
    t.phone || t["contact:phone"] || "",
    t.website || t["contact:website"] || "",
    t["contact:instagram"] || "",
  ];
  while (row.length > 5 && row[row.length - 1] === "") row.pop(); // retire les champs vides en fin
  return row;
}

// POST avec le module https (compatible avec les anciennes versions de Node, sans fetch).
function post(url, body, headers) {
  return new Promise((resolve, reject) => {
    const req = require("https").request(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body), ...headers },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        resolve(text);
      });
    });
    req.on("error", reject);
    req.end(body);
  });
}

async function main() {
  for (let attempt = 1; attempt <= 4; attempt++) {
    console.log(`Requête Overpass (essai ${attempt})…`);
    const t0 = Date.now();
    try {
      const text = await post(ENDPOINT, new URLSearchParams({ data: query }).toString(), {
        "User-Agent": "carte-friperies/1.0 (update-data script)",
      });
      const json = JSON.parse(text);
      if (json.remark) throw new Error(json.remark);
      const shops = json.elements.map(compact).filter(Boolean);
      shops.sort((a, b) => (a[0] < b[0] ? -1 : 1)); // ordre stable, pour comparer d'un jour à l'autre
      if (shops.length < 1000) throw new Error(`seulement ${shops.length} boutiques, résultat suspect`);

      // Rien de nouveau : on ne touche pas au fichier (évite un commit inutile).
      try {
        const previous = JSON.parse(fs.readFileSync(OUT, "utf8"));
        if (JSON.stringify(previous.shops) === JSON.stringify(shops)) {
          console.log(`= Aucun changement (${shops.length} boutiques).`);
          return;
        }
      } catch { /* pas encore de fichier */ }

      const data = { generated: new Date().toISOString(), bbox: BBOX, shops };
      fs.mkdirSync(path.dirname(OUT), { recursive: true });
      fs.writeFileSync(OUT, JSON.stringify(data));
      const kb = Math.round(fs.statSync(OUT).size / 1024);
      console.log(`✓ ${shops.length} boutiques, ${kb} Ko, en ${Math.round((Date.now() - t0) / 1000)} s → ${OUT}`);
      return;
    } catch (err) {
      console.warn(`  échec : ${err.message}`);
      await new Promise((r) => setTimeout(r, 10000 * attempt));
    }
  }
  process.exitCode = 1;
}

main();
