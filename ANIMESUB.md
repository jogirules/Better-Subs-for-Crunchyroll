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
node tools/test-buildsigns.mjs
```

Po zmianie `extension/lib/protocol.js` albo `settings-schema.js` przebuduj kopię dla
content.js: `node tools/build-iso-bundle.mjs` (bez tego nowe wiadomości do service
workera giną z błędem „message port closed”).

## Jak używać

1. Odcinek na Crunchyroll → ▾ obok przycisku napisów → **🔎 Szukaj napisów PL**.
2. Panel sam ustala frazę: tytuł serii i numer odcinka z Crunchyroll → tytuł romaji
   sezonu z AniList → np. `Kusuriya no Hitorigoto 3rd Season ep05`. Próbuje do 3 wariantów
   (numer w sezonie / absolutny / bez numeru) i zatrzymuje się na pierwszym, który daje
   wyniki z tym tytułem. Frazę i typ tytułu (oryginalny / angielski / polski) można zmienić.
3. Opis wyniku (kliknij, żeby rozwinąć) zwykle mówi, do jakiego wydania jest synchro
   (CR, SubsPlease, Erai-raws, BD, TV).
4. **Pobierz** → archiwum rozpakowuje się w przeglądarce; przy kilku plikach wybierasz
   jeden. Źródło dostaje plakietkę „AnimeSub”, a „ukryj napisy Crunchyroll” włącza się
   samo (CR wypala napisy w obraz).
5. Wybór i ręczne synchro są pamiętane per odcinek. Po powrocie napisy włączają się same;
   po wygaśnięciu cache (30 dni) panel pokazuje „Pobierz ponownie”.

### Foldery MEGA grup

W panelu AnimeSub przycisk **📁 Foldery MEGA** (albo ▾ → Manage → **📁 Szukaj w folderach
MEGA grup…**) przeszukuje naraz publiczne foldery Shisha Subs, FrixySubs i FujiSubs po nazwach plików (przy równym dopasowaniu Shisha jest pierwsza). Grupy bez folderu zbiorczego są w indeksie tytuł → folder serii (Max-Subs: 2 serie, Fusoku Subs: 48); folder serii jest otwierany tylko, gdy tytuł pasuje. Pola:
tytuł (romaji, jak na AniList) i numery odcinka (np. `5, 53` — w sezonie i absolutny; puste =
cały sezon). Panel sam wpisuje tytuł i numery z Crunchyroll/AniList. Pierwsze wyszukiwanie
pobiera listę plików folderu (kilka sekund), potem przez 12 h szuka lokalnie (↻ odświeża).
Pobierany jest tylko kliknięty plik; odszyfrowanie dzieje się w przeglądarce. **+ Dodaj link**
dopisuje folder innej grupy (link `https://mega.nz/folder/…#klucz`; sprawdzany przed zapisem).
Plakietka źródła: „MEGA”; wybór i synchro pamiętane per odcinek jak przy AnimeSub.
**Czcionki grup.** Po włączeniu napisów z MEGA albo AnimeSub rozszerzenie dociąga czcionki,
których używa plik (Fontname stylów i `\fn`): z folderu czcionek tej serii u tej samej grupy
(`Czcionki/`, `Fonty/`, `<Seria> Fonty`), a dla AnimeSub — z folderu serii o tym tytule w MEGA
dowolnej grupy (najpierw ten sam sezon). Brakujące nazwy szuka jeszcze po nazwie pliku w całych
folderach Shishy/FrixySubs/FujiSubs. Czcionki trafiają do libass (znaki) i do nakładki CSS
(dialogi, gdy nie wymuszasz własnej czcionki). Pierwszy raz na serię: kilka–kilkanaście sekund
(napisy działają od razu, czcionki podmieniają się po pobraniu); potem z pamięci podręcznej.
Konsola strony: `[CR Sub Fix] group fonts: +N … not found: …`.

Inne źródła: ▾ → Manage → **＋ Load subtitle file / ZIP…** albo przeciągnij plik
(.ass/.srt/.txt/.sub/.zip) na stronę odcinka.

## Scenariusz testowy

| Odcinek CR | Oczekiwana fraza | Wydanie |
|---|---|---|
| [Frieren S2 E1](https://www.crunchyroll.com/watch/GMKUEXKDD/shall-we-go-then) | `Sousou no Frieren 2nd Season ep01` | FujiSubs (synchro CR) |
| [Frieren S1 E1](https://www.crunchyroll.com/watch/G0DUND0K2/the-journeys-end) | `Sousou no Frieren ep01` | Fusoku Subs (LZMA, SubsPlease) |
| [Kusuriya E53](https://www.crunchyroll.com/watch/GE00384331JAJP/the-white-snake-immortal) | `Kusuriya no Hitorigoto 3rd Season ep05` | FrixySubs (numeracja absolutna CR → sezonowa) |
| [Kusuriya E29](https://www.crunchyroll.com/watch/GEVUW3VGJ/moon-fairy) | `Kusuriya no Hitorigoto 2nd Season ep05` | FrixySubs (opisane jako TMPlayer, w środku ASS) |
| Kusuriya E53 → 📁 Foldery MEGA | `Kusuriya no Hitorigoto 3rd Season`, odc. `5, 53` | `[FrixySubs] Kusuriya no Hitorigoto - S03E05 (53).ass` |
| Mushoku Tensei S3 E8 → 📁 Foldery MEGA | `Mushoku Tensei: Isekai Ittara Honki Dasu Season 3`, odc. `8` | `[shisha] Mushoku Tensei S3 - 08.ass` (folder „Mushoku Tensei III”) |
| Frieren S2 E1 → 📁 Foldery MEGA | `Sousou no Frieren 2nd Season`, odc. `1, …` | FujiSubs i FrixySubs (`Sousou no Frieren S2 - 01.ass`) |

Sprawdź: polskie znaki (ąęłóśźżćń), brak podwójnych napisów, napisy w trybie pełnoekranowym,
powrót do odcinka (wybór i synchro zostają). Diagnostyka: konsola strony (F12), linie
`[CR Sub Fix]` — m.in. `AnimeSub title:` pokazuje, co przyszło z Crunchyroll i z AniList.

## Dostrajanie synchronizacji (wydania TV, BD, inne fps)

Napisy robione pod SubsPlease/Erai-raws/CR zwykle pasują od razu — to zgrania z Crunchyroll.
Rozszerzenie próbuje też samo dopasować czas do polskich napisów CR, jeśli odcinek je ma (dopasowanie po
treści; komunikat po sukcesie). Gdy dalej się rozjeżdża, ustal rodzaj błędu:

- **Stałe przesunięcie** (cały czas o tyle samo za wcześnie / za późno): wydanie TV miało
  inną długość wstępu, zapowiedź albo planszę sponsora. ▾ → Manage → **⚙ Adjust sync** →
  przyciski **−0.1s / +0.1s** aż pasuje.
- **Rozjazd narastający** (na początku dobrze, pod koniec coraz gorzej): inne tempo —
  napisy klatkowe (MicroDVD `{klatka}`) liczone przy innym fps (25 vs 23,976) albo wydanie TV
  z innym cięciem. W **⚙ Adjust sync**: przy pierwszej linii (cytat w panelu) kliknij
  **Mark now** w chwili, gdy pada ona w filmie, to samo przy ostatniej linii — rozszerzenie
  wylicza tempo i przesunięcie z dwóch punktów.
- **Skok w środku** (do pewnego momentu dobrze, potem stałe przesunięcie): wydanie TV z
  przerwą reklamową lub wyciętą sceną. Dwa punkty tego nie naprawią — szukaj innego
  wydania (opis „CR”, „WEB”, „SubsPlease”).

**Reset** wraca do oryginalnego czasu. Ręczne synchro dla napisów z AnimeSub jest
zapamiętywane razem z wyborem odcinka.

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
