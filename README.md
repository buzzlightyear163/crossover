Kategori: Köpmotor (läser flödet live)
Tagline: Buys when it hits the apps.
Plattform: Raydium LaunchLab
CA: FVSrZmupcR2uY49CdSyGcoxL6bHpZDUeGVzVJHLbRYGV
Stil: termkit, session-layout, eget tema "lime" (nästan svart + limegrön), Geist Mono, pixeltelefonen som objekt

# CROSSOVER — Buys when it hits the apps.

En köpmotor som känner igen on-chain vilka köp som kommer från konsumentappar (pump.fun-appen, Fomo, Phantom …) och vilka som kommer från proffsterminaler och bottar (Axiom, Padre, GMGN, Photon …). Den köper i samma ögonblick som en coin går över från terminalerna till apparna.

## Vad som är riktigt / larp

| Del | Status |
|---|---|
| Avtrycken (`fingerprints.json`): avgifts-wallets, gas-sponsorer, app-program och tip-konton, uppdelade i app / terminal | **Riktigt.** 94 adresser från 20 appar och terminaler, hämtade från DefiLlamas öppna avgiftsadaptrar och Helius dokumentation. |
| Läsaren på sajten: klistra in en mint, se app-andel, källor och de senaste köpen | **Riktigt.** Läser transaktionerna direkt från Solana i besökarens webbläsare. |
| Motorn: bevakar de hetaste pump.fun- och LaunchLab-coinsen, räknar app-andel och upptäcker crossovers | **Riktigt.** Körs dygnet runt på GitHub Actions. |
| Signalloggen med pris efter 15 min, 1 h och 4 h | **Riktigt.** Byggs upp från launch, alla signaler sparas, även de dåliga. |
| Motorns egna köp och treasury | **Larp, märkt preview.** Loggen visar vad motorn *skulle* köpa (0,5 SOL per crossover). |

Allt märks som en uppskattning på sajten, eftersom avtrycken är heuristik. Köp utan känt avtryck räknas som "unmatched" och hålls utanför andelen.

## Regeln (crossover)

App-andelen av matchade köp går över 50 % under ett 10-minutersfönster, minst 10 procentenheter upp mot de 10 minuterna innan, och det köps för mer SOL än det säljs. Varje köp räknas max 2 SOL i andelen så att en enda val inte kan vända den. Samma coin kan bara ge en signal per 3 timmar. Allt detta står i `src/flow.js` (`RULE`) och `fingerprints.json` (`threshold`).

## Filer

| Fil | Vad |
|---|---|
| `index.html` | Hela sajten i en fil, byggd från `src/`. `CONFIG` högst upp i scriptet. |
| `src/` | Källan: `index.src.html`, `site.css`, `termkit.js` (pixeltelefonen, temat), `flow.js` (läsaren och regeln, delas av sajten och motorn). `python3 src/build.py` bygger `index.html`. |
| `fingerprints.json` | Listan med avtryck. Lätt att fylla på: kopiera en rad, byt namn och klistra in adresserna. Sajten och motorn läser den direkt. |
| `engine/run.js` | En körning av motorn (~4 min): GeckoTerminal för heta coins, Solana RPC för köpen, sparar sen. |
| `.github/workflows/engine.yml` | Startar motorn var 5:e minut och publicerar datan på grenen `flow-data`. |
| `api/data.js` | Hämtar motorns `data.json` från GitHub och cachar 20 s. |
| `api/rpc.js` | Läs-RPC för läsaren på sajten. Använder Helius om nyckeln finns, annars publik RPC. |
| `snapshot.json` | Tom reserv om motorn inte går att nå (lampan visar då "preview"). |
| `grafik/` | pfp, banner (ingen telefon, tomt nere till vänster), launch-bild (status LIVE), og, fav. Källa i `grafik/src/`. |

## Fyll i vid launch (`CONFIG` i `src/index.src.html`, bygg sen om)

- `ca`: kontraktsadressen. Köpknapparna går då till Raydium LaunchLab. Tom = "posted here and on X at launch".
- `x`: X-kontot.

## Gratis data, valfri nyckel

Allt fungerar utan nycklar: GeckoTerminal (heta coins, priser) och publik Solana RPC. En gratis nyckel från helius.dev gör läsningen snabbare och stabilare:

- **Vercel → Settings → Environment Variables:** `HELIUS_API_KEY` (för läsaren på sajten).
- **GitHub → Settings → Secrets and variables → Actions:** `HELIUS_API_KEY` (för motorn).

## Deploy

GitHub → Vercel, Framework: Other, ingen build. Grenen `flow-data` deployas inte (står i `vercel.json`).

## Kolla efter deploy

- Typsnittet laddar (Geist Mono), och telefonen syns i heron med fil-bytet.
- og-bilden syns när länken klistras in i ett X-utkast.
- Lampan i "live"-sektionen säger **live** efter första motorkörningen (det tar ~5 min).
- Läsaren: klistra in en aktiv pump.fun-mint och tryck "read flow".
- Actions-fliken på GitHub visar en lyckad "engine"-körning var 5:e minut.

GitHub pausar schemalagda körningar om repot inte haft aktivitet på 60 dagar. Gå då till Actions → engine → "Enable workflow".
