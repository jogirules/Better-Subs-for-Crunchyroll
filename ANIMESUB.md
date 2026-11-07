# Better Subs + AnimeSub.info (fork prywatnego użytku)

Fork [Better Subs for Crunchyroll](https://github.com/anitastic-pixel/Better-Subs-for-Crunchyroll)
(licencja MIT, © anitastic-pixel) z dodatkowym źródłem napisów: wyszukiwanie i
pobieranie polskich fansubów z AnimeSub.info prosto w odtwarzaczu Crunchyroll.

Prace trwają na gałęzi `animesub`. Aktualizacje oryginału: `git fetch upstream &&
git merge upstream/main` (push do `upstream` jest zablokowany).

## Instalacja (Load unpacked)

1. Jeśli masz zainstalowane Better Subs ze sklepu Chrome — wyłącz je
   (`chrome://extensions`, przełącznik przy rozszerzeniu), inaczej dwie nakładki
   będą walczyć o odtwarzacz.
2. Otwórz `chrome://extensions`.
3. Włącz **Tryb dewelopera** (przełącznik w prawym górnym rogu).
4. Kliknij **Załaduj rozpakowane** i wskaż katalog `extension/` z tego repo.
5. Po każdej zmianie kodu: przycisk ⟳ na karcie rozszerzenia, potem odśwież kartę
   Crunchyroll.

## Testy logiki (bez przeglądarki)

```bash
node tools/test-logic.mjs
node tools/test-animesub.mjs
```

## Jak działa AnimeSub (stan z 2026-11-07, sprawdzone na żywo)

- Tylko HTTP (`http://animesub.info`), strona w ISO-8859-2.
- Wyszukiwanie: `GET /szukaj.php?szukane=<fraza>&pTitle=org|en|pl`, 30 wyników
  na stronę, `od=N` — kolejne strony. Dopisek `epNN` zawęża do odcinka.
- Ciasteczko `ansi_sciagnij` ustawia sama wyszukiwarka.
- Każdy wynik ma ukryte pola `id` i `sh`. **`sh` jest ważne tylko z ostatniej
  odpowiedzi wyszukiwarki w danej sesji** — dlatego pobranie zawsze robi świeże
  wyszukiwanie, a cache trzyma wyniki bez `sh`.
- Pobranie: `POST /sciagnij.php` (`id`, `sh`, `single_file`) → ZIP. Kompresja
  bywa deflate (starsze) albo LZMA (nowsze).
- Kodowanie plików: UTF-8 (często z BOM), CP1250 albo ISO-8859-2.
