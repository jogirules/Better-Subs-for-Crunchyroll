# Plan: polskie napisy w Better Subs (stan 2026-11-07)

Źródła napisów → jedna wspólna ścieżka: **bajty → (ZIP?) → dekodowanie znaków →
(stary format → SRT) → `makeLocalSource` → istniejący mechanizm custom source**
(render, typesetting, synchro i pamięć per odcinek bez zmian).

## Etapy

| # | Etap | Stan |
|---|---|---|
| 0 | Fork `jogirules/Better-Subs-for-Crunchyroll`, gałąź `animesub`, `ANIMESUB.md` | ✅ |
| 1 | Czyste biblioteki + testy Node: `zip-read` (stored/deflate/LZMA), `animesub` (parser), `legacy-subs` (TMPlayer/MicroDVD/MPL2), `text-decode` | ✅ |
| 1b | **Wspólna ścieżka „bajty → napisy”** (`lib/sub-ingest.js`) + istniejące „Wczytaj plik” przyjmuje też `.zip`/`.txt`/`.sub` i przeciąganie pliku na odtwarzacz | ✅ (UI wyboru z archiwum i drop — do sprawdzenia na odcinku) |
| 2 | Spike w service workerze: AnimeSub wyszukaj → pobierz → rozpakuj → zdekoduj; weryfikacja, czy `fetch` z SW niesie ciasteczko `ansi_sciagnij` | ✅ (cookie działa; 3 żądania / 6,7 s) |
| 3 | RPC `animesubSearch`/`animesubDownload`, kolejka ≥ 3 s między żądaniami, cache wyników 24 h (bez `sh`) | ✅ (relay sprawdzony w Chromium: szukanie 153 ms, z cache 1 ms, ZIP 6 s) |
| 4 | UI „Szukaj na AnimeSub”: fraza, typ tytułu, lista wyników, wybór pliku z archiwum; id `custom:animesub` | ✅ kod; panel do sprawdzenia na koncie (bez logowania brak odtwarzacza) |
| 5 | Tytuł/odcinek ze strony CR + AniList (romaji, cache) | ✅ (CR cms/objects + AniList; panel do sprawdzenia na koncie) |
| 6 | Pamięć per odcinek: metadane źródła w rekordzie (`site`, `id`, autor) | ✅ kod (wybór źródła per odcinek, pick AnimeSub 1 rok + synchro, „Pobierz ponownie”); do sprawdzenia na koncie |
| 7 | Instrukcja testów (Kusuriya S3, Frieren) i strojenia synchronizacji | ✅ ANIMESUB.md: użycie, scenariusz testowy, synchro TV/BD/fps |
| 8 | **Foldery MEGA grup** (zamiast Discorda): publiczne foldery „wszystkie napisy” FrixySubs i FujiSubs + własne linki; lista plików odszyfrowana w przeglądarce, cache 12 h, wyszukiwanie po nazwie pliku, pobranie i odszyfrowanie AES-CTR jednego pliku; id `custom:mega` | ✅ SW sprawdzony w Chromium (szukanie 0,5 s, z cache 17 ms, ASS 82 kB w 0,25 s); panel do sprawdzenia na koncie |
| 9 | Czcionki z folderów `Czcionki/` grup dla libass; Discord (wariant B) tylko jeśli MEGA nie wystarczy | później |

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

## Etap 8 — wybrany wariant: foldery MEGA (2026-11-07)

Test na Discordzie: kanały wydań grup zawierają linki i obrazki, nie załączniki z napisami;
pliki leżą w publicznych folderach MEGA, linkowanych przez grupy. Link do folderu niesie
klucz po `#`, więc nie ma logowania ani tokenu. Protokół (sprawdzony): `POST g.api.mega.co.nz/cs?n=<folder>`
`[{a:'f',c:1,ca:1,r:1}]` → węzły z atrybutami AES-CBC i kluczami AES-ECB pod kluczem folderu;
`[{a:'g',g:1,ssl:1,n:<plik>}]` → URL na `gfs*.userstorage.mega.co.nz` (CORS `*`), treść AES-CTR.
FrixySubs: 9722 węzły / ~4100 plików napisów w jednym żądaniu (0,3 s), FujiSubs ~900.
Kod: `lib/mega.js` (czyste funkcje + testy), `background.js` (sieć, cache, WebCrypto),
panel „📁 Foldery MEGA” w `interceptor.js`. Wariant Discord poniżej zostaje jako zapis decyzji.

## Etap 8 (odrzucony wariant) — Discord, przepływ z 2026-11-07

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

## Ustalenia z testów na żywo (2026-11-07)
- **Podwójne napisy**: nowy odtwarzacz CR wypala w obraz napisy w języku konta (PL),
  więc nakładka rysowała się nad nimi. Wybór własnego źródła włącza teraz
  `hideOfficialSubs` (przejście na strumień bez napisów, na żywo albo po odświeżeniu).
- `sh` z ostatniego wyszukiwania działa dla wszystkich wyników tej strony.
- CR numeruje Kusuriya absolutnie (S3 ep05 = E53) — etap 5 musi to przeliczać.
- Metadane formatu na AnimeSub bywają błędne ("TMPlayer" z ASS w środku) — format
  rozpoznajemy po treści.

## Ustalenia do etapu 5 (sprawdzone 2026-11-07 na CR, AniList, AnimeSub)

- CR `cms/objects/<guid>`: `sequence_number` = odcinek w sezonie, `episode_number` = absolutny,
  `episode_air_date` = oryginalna emisja JP także dla serii dodanych później (Death Note: 2006, na CR od 2025).
- CR `season_number` to kolejność wpisów, nie sezon (Black Clover „Season 2” = 6, Re:ZERO „Season 2” = 3)
  → wpis AniList wybiera data emisji; numer tylko jako fallback.
- AnimeSub numeruje niejednolicie: w sezonie (Kusuriya 3rd Season ep05), ciągle przez cour (Spy x Family ep13),
  absolutnie (Black Clover ep52) → do 3 prób zapytania, stop na pierwszym realnym trafieniu.
- Znak „×” psuje wyszukiwarkę AnimeSub (zwraca dowolne „epNN”) → zamiana na „x” + sprawdzanie tytułu wyników.
- Uploaderzy piszą „Season 3” zamiast „3rd Season” → porównanie po znormalizowanym numerze sezonu.
- Token CR wygasa po ~5 min → do zapytania o metadane brany jest najświeższy nagłówek z ruchu strony.
