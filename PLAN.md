# Plan: polskie napisy w Better Subs (stan 2026-11-07)

Źródła napisów → jedna wspólna ścieżka: **bajty → (ZIP?) → dekodowanie znaków →
(stary format → SRT) → `makeLocalSource` → istniejący mechanizm custom source**
(render, typesetting, synchro i pamięć per odcinek bez zmian).

## Etapy

| # | Etap | Stan |
|---|---|---|
| 0 | Fork `jogirules/Better-Subs-for-Crunchyroll`, gałąź `animesub`, `ANIMESUB.md` | ✅ |
| 1 | Czyste biblioteki + testy Node: `zip-read` (stored/deflate/LZMA), `animesub` (parser), `legacy-subs` (TMPlayer/MicroDVD/MPL2), `text-decode` | ⏳ czeka na `pickLegacyEncoding` (TODO human) |
| 1b | **Wspólna ścieżka „bajty → napisy”** (`lib/sub-ingest.js`) + istniejące „Wczytaj plik” przyjmuje też `.zip`/`.txt`/`.sub` i przeciąganie pliku na odtwarzacz | nowy |
| 2 | Spike w service workerze: AnimeSub wyszukaj → pobierz → rozpakuj → zdekoduj; weryfikacja, czy `fetch` z SW niesie ciasteczko `ansi_sciagnij` | |
| 3 | RPC `animesubSearch`/`animesubDownload`, kolejka ≥ 3 s między żądaniami, cache wyników 24 h (bez `sh`) | |
| 4 | UI „Szukaj na AnimeSub”: fraza, typ tytułu, lista wyników, wybór pliku z archiwum; id `custom:animesub` | |
| 5 | Tytuł/odcinek ze strony CR + AniList (romaji, cache) | |
| 6 | Pamięć per odcinek: metadane źródła w rekordzie (`site`, `id`, autor) | |
| 7 | Instrukcja testów (Kusuriya S3, Frieren) i strojenia synchronizacji | |
| 8 | **Discord: przycisk „Wyślij do Better Subs” przy załącznikach w discord.com (web)** → skrzynka napisów w rozszerzeniu → wybór w odtwarzaczu CR; id `custom:discord` | nowy, po decyzji |

## Discord — ustalenia i granice

- Wtyczka `external_plugins/discord` (claude-plugins-official) to most **bot ↔ sesja
  Claude Code**. Bot widzi tylko serwery, na które dodał go *administrator serwera*,
  i tylko kanały włączone w jego konfiguracji; API wyszukiwania nie jest dostępne dla
  botów (`fetch_messages` ≤ 100 wiadomości). Na serwer FrixySubs/Fumetsu itp. bota
  nie dodamy bez zgody ich administracji → **nie rozwiązuje problemu źródła**.
  Dodatkowo działa przez Claude Code, a nie w przeglądarce podczas oglądania.
- Automatyzacja zwykłego konta (self-bot, token użytkownika) łamie regulamin
  Discorda i grozi banem konta → **odrzucone**.
- Wykonalne bez łamania zasad: użytkownik sam jest na serwerze grupy, sam klika
  plik. Wariant A: pobiera plik i wczytuje go (etap 1b). Wariant B (etap 8): przycisk
  dodany przez rozszerzenie przy załączniku w Discord **web**; rozszerzenie pobiera
  ten jeden plik z `cdn.discordapp.com` (podpisany URL, ważny ok. doby) i odkłada do
  skrzynki. Bez tokenu, bez automatycznego przeglądania kanałów. Ryzyko: regulamin
  Discorda zabrania modyfikowania klienta — rozszerzenie w przeglądarce to szara
  strefa (dużo mniejsza niż self-bot); selektory DOM Discorda często się zmieniają.
- Artykuł strefaanime.pl (2022, zaktualizowany 2023) wymienia ~19 grup; prawie każda
  ma Discord, ale wiele ma też stronę / ANSI / folder „Napisy” (np. FrixySubs,
  FujiSubs, Grupa Mirai, Max-Subs, Hori Subs, Fusoku — ta ostatnia to autorzy
  pliku Frieren pobranego z AnimeSub). Lista jest sprzed 3–4 lat; część grup mogła
  zniknąć — do sprawdzenia, zanim zbudujemy coś pod konkretną grupę.
