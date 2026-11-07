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
| 8 | **Discord: „Szukaj w Discordzie” z odtwarzacza CR → karta Discorda z wpisanym wyszukiwaniem → „Wyślij do Better Subs” przy załączniku → napisy same trafiają do odcinka**; id `custom:discord` | nowy, po decyzji |

## Discord — ustalenia i granice

- Wtyczka `external_plugins/discord` (claude-plugins-official) to most **bot ↔ sesja
  Claude Code**. Bot widzi tylko serwery, na które dodał go *administrator serwera*,
  i tylko kanały włączone w jego konfiguracji; wtyczka nie udostępnia wyszukiwania
  (`fetch_messages` ≤ 100 wiadomości), a endpoint Search Guild Messages z dokumentacji
  Discorda i tak działa tylko na serwerze, na którym bot jest. Na serwer FrixySubs/Fumetsu itp. bota
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

## Etap 8 — przepływ (wersja z 2026-11-07, po weryfikacji)

Fakty: Discord ma linki do serwera/kanału (`discord.com/channels/<serwer>/<kanał>`),
ale **nie znalazłem udokumentowanego linku z gotowym wyszukiwaniem**. Za to jego
wyszukiwarka indeksuje **nazwy i rozszerzenia załączników** (oficjalna dokumentacja
endpointu Search Guild Messages: `attachment_filename`, `attachment_extension`,
`has=file`). Brakujący element robi skrypt rozszerzenia na discord.com.

1. CR: przycisk „Szukaj w Discordzie” (obok AnimeSub) → wybór serwera z listy
   (lub „wszystkie” = karta na serwer). Fraza: romaji + odcinek, edytowalna.
2. SW zapisuje „zlecenie” `{serwer, kanał?, fraza, guid odcinka, karta CR}` i otwiera
   kartę `discord.com/channels/<serwer>`.
3. Skrypt na discord.com: jeśli jesteś zalogowany — wpisuje frazę (+ `has:file`) w
   pole wyszukiwania tak, jakbyś ją wpisał. Gdy się nie uda (zmiana UI) — pływający
   panel „Kopiuj frazę”.
4. Przy każdym załączniku `.ass/.ssa/.srt/.txt/.sub/.zip` w wynikach: „Wyślij do
   Better Subs”. Klik → SW pobiera ten plik z `cdn.discordapp.com` → wspólna ścieżka
   (ZIP, kodowanie, formaty) → rekord trafia do odcinka o zapisanym guid → karta CR
   wraca na wierzch, napisy włączone.
5. „Dodaj ten serwer do Better Subs”: przycisk na discord.com zapamiętuje id i nazwę
   serwera (opcjonalnie kanał z wydaniami). Zaproszenia do grup — z artykułu strefaanime.

Ręczne kroki: klik „Szukaj”, (jednorazowe logowanie), wybór wyniku, klik „Wyślij”.

Czego NIE robimy: wywołań API Discorda Twoim tokenem (self-bot — regulamin, ban),
przeglądania kanałów w tle, pobierania czegokolwiek bez kliknięcia.
Ryzyka: wpisywanie w pole wyszukiwania i dodatkowe przyciski to modyfikacja klienta
(szara strefa regulaminu, wyzwalana tylko przez Ciebie); selektory DOM Discorda
zmieniają się — kod izolowany w jednym pliku, z fallbackiem „Kopiuj frazę”.
Ograniczenie: grupy wydające tylko MKV z wbudowanymi napisami (softsuby) — wyciąganie
ASS z MKV to osobny, cięższy etap (pliki setek MB); na razie poza zakresem.
Do sprawdzenia na żywo (spike): czy wpisany tekst bez filtra trafia w nazwy plików,
jak wyglądają wyniki i przyciski pobierania w DOM, czy URL z CDN działa z SW.
