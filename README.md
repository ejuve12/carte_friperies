# Carte des friperies

Application web qui recense sur une carte les friperies, dépôts-ventes et boutiques solidaires.

## Lancer l'application

```bash
node serve.js
```

Puis ouvrir http://localhost:8080.

## Fonctionnalités

- Carte interactive (Leaflet + OpenStreetMap) avec regroupement des marqueurs
- Recherche d'une ville ou d'une adresse (Nominatim)
- Géolocalisation « Autour de moi »
- Filtres par type : friperie / dépôt-vente, boutique solidaire, vêtements d'occasion
- Liste triée par distance, filtre par nom
- Fiche boutique : adresse, horaires, téléphone, site, Instagram, itinéraire
- Favoris enregistrés dans le navigateur
- **Application mobile installable (PWA)** : icône sur l'écran d'accueil, plein écran,
  dernière recherche et carte déjà vue disponibles hors ligne

## Installer sur mobile

L'app doit être hébergée en **HTTPS** (Netlify, GitHub Pages…) pour être installable.

- **Android (Chrome)** : bouton « 📲 Installer l'application » dans la liste, ou menu ⋮ → « Installer l'application ».
- **iPhone (Safari)** : bouton Partager → « Sur l'écran d'accueil ».

Après une modification des fichiers, incrémenter `VERSION` dans `sw.js` pour que les
téléphones récupèrent la nouvelle version. Les icônes se régénèrent avec
`node tools/make-icons.js`.

## Données

Les boutiques proviennent d'OpenStreetMap (`shop=second_hand`, `shop=charity`,
`shop=vintage`, `shop=clothes` + `second_hand=yes|only`).

- **France et zones frontalières** : extraites une fois dans `data/friperies.json`
  (~7 500 boutiques, ~250 Ko compressé). La recherche est instantanée et marche hors ligne.
- **Ailleurs** : interrogation en direct de l'API Overpass (plus lente).

Le fichier est **mis à jour automatiquement chaque nuit** par GitHub Actions
(`.github/workflows/deploy.yml`), qui republie ensuite l'app. Les téléphones récupèrent
les nouvelles données au lancement suivant, sans rien réinstaller.

Mise à jour manuelle (environ 2 minutes) :

```bash
node tools/update-data.js
```

Une boutique manquante ou erronée se corrige directement sur openstreetmap.org et
apparaîtra dans l'app le lendemain.

## Mise en ligne (GitHub Pages)

1. Créer un dépôt sur GitHub et y envoyer ce dossier (branche `main`).
2. Dans le dépôt : **Settings → Pages → Source : « GitHub Actions »**.
3. Onglet **Actions** → « Mise à jour et publication » → **Run workflow** pour le premier lancement.

L'app est alors disponible sur `https://<pseudo>.github.io/<depot>/`, mise à jour chaque
nuit à 3h17 UTC et à chaque modification du code.

## Fichiers

- `index.html` : structure de la page
- `style.css` : mise en forme (responsive mobile)
- `app.js` : carte, récupération des données, filtres, favoris
- `manifest.webmanifest`, `sw.js`, `icons/` : partie « application installable »
- `serve.js` : mini serveur de développement
