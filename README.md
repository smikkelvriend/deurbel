# Deurbel: je eigen app voor de Eufy-deurbel

Een eigen app voor je Eufy-deurbel. Hij draait op je Ubuntu-server, zodat je de Eufy-app niet meer nodig hebt.

**Wat hij kan**

| | |
|---|---|
| 🔔 Meldingen | Bij aanbellen meteen een melding, met de foto erachteraan. Optioneel ook bij een persoon, beweging of pakket. |
| 📺 Live | Live beeld **met geluid** en weinig vertraging. Ook in volledig scherm. |
| 🎙 Terugpraten | Praat via je telefoon door de deurbel (heeft HTTPS nodig, zie stap 7). |
| 💬 Snelle antwoorden | De ingesproken berichten van de deurbel afspelen ("Ik kom eraan!"). |
| ▶ Opnames | Bij aanbellen, personen en pakketten neemt de server zelf op, met geluid. Je kunt ze terugkijken, opslaan op je telefoon, bewaren met ★ of wissen. |
| 🕐 Timelapse | Om de zoveel minuten (instelbaar) een foto. Je kunt per dag terugscrollen in de tijd, het afspelen als timelapse of downloaden als video. |
| 💾 Opslaglimiet | Stel zelf in hoeveel GB je wilt gebruiken. Is het vol, dan gaan de oudste opnames weg (★-opnames blijven staan). Optioneel ook "na X dagen wissen". |
| 🛡 Beveiligingsmodus | Afwezig / Thuis / Schema / Uitgeschakeld. |
| 🌙 Niet storen | Bel en meldingen tijdelijk stil (30 min tot 8 uur). |
| ⚙ Instellingen | Alle instellingen die de deurbel doorgeeft: detectie, gevoeligheid, nachtzicht, kwaliteit, volume, binnenbel, batterijmodus, opnamelengte, rondhangen, pakketbewaking, automatisch antwoorden, enzovoort. |
| 📋 Logboek | Alle gebeurtenissen met foto en filters. |

Onder de motorkap draait **eufy-security-ws**, een open-source project dat rechtstreeks met de deurbel praat.

### Wat de Eufy-app wel kan en deze app niet

- Detectiezones tekenen in het beeld
- Firmware-updates installeren
- De deurbel installeren of de wifi wijzigen
- Een nieuw snel antwoord inspreken (bestaande berichten afspelen kan wel)
- Gezichtsherkenning trainen

Deze dingen stuurt Eufy niet door naar andere programma's. Je stelt ze één keer in met de Eufy-app en daarna heb je die app niet meer nodig.

---

## 1. Welk Eufy-account?

De server moet één keer inloggen bij Eufy. Je hebt twee opties:

- **Je eigen account** (aanrader). Kies dit als je de Eufy-app niet meer gaat gebruiken. Je hebt dan alle rechten, ook voor de instellingen en de beveiligingsmodus.
- **Een tweede account.** Kies dit als je de Eufy-app af en toe nog wilt kunnen openen. Twee apparaten tegelijk op één account gooien elkaar er soms uit. Deel de deurbel in de Eufy-app met dat tweede account, als beheerder als dat kan. De server accepteert de uitnodiging vanzelf. Een gedeeld account mag soms niet alle instellingen wijzigen.

## 2. Installeren (één commando)

Open op je server een terminal (Cockpit → Terminal) en plak:

```bash
curl -fsSL https://raw.githubusercontent.com/smikkelvriend/deurbel/main/install.sh | bash
```

Het script doet dit:
- Het installeert git en Docker, als die er nog niet zijn.
- Het zet de app in `~/deurbel`.
- Had je al een versie draaien, dan neemt het je `.env`, opnames, foto's en Eufy-login mee. De oude map blijft bewaard als `~/deurbel-oud-…`.
- Het start alles.

**Eerste keer?** Dan stopt het script en vraagt het je om `.env` in te vullen:

```bash
nano ~/deurbel/.env
```

| Wat | Uitleg |
|---|---|
| `EUFY_EMAIL` / `EUFY_PASSWORD` | Het account uit stap 1 |
| `APP_PIN` | Pincode voor het dashboard |
| `PORT` | Poort van het dashboard, bijvoorbeeld `8095` als 8080 al in gebruik is |
| `PUBLIC_URL` | Bijvoorbeeld `http://192.168.0.236:8095` |
| `NTFY_TOPIC` | Een lange, zelfbedachte naam voor je meldingen |
| `STATION_IP_ADDRESSES` | Optioneel bij een HomeBase: `serienummer:ip`, bijvoorbeeld `T8010P2524473982:192.168.0.138` |

Opslaan met `Ctrl+O`, `Enter` en `Ctrl+X`. Draai daarna het installatiecommando nog een keer.

## 3. Automatische updates

Na de installatie draait er een kleine **updater** mee. Die kijkt elke 6 uur op GitHub of er een nieuwe versie is en werkt de app dan vanzelf bij. Je `.env`, opnames en foto's blijven altijd staan. Lukt een update niet, dan zet hij de vorige versie terug.

- In het dashboard zie je onder Instellingen → **Updates** welke versie je hebt. Daar kun je ook zelf **Controleren** of **Nu bijwerken**.
- Liever zelf beslissen wanneer er bijgewerkt wordt? Zet `AUTO_UPDATE=false` in `.env`. Je ziet dan "Update beschikbaar" met een knop.
- Hoe vaak hij kijkt, stel je in met `UPDATE_HOURS`.
- De koppeling met Eufy (eufy-security-ws) wordt ook bijgewerkt. Wil je dat niet, zet dan `UPDATE_EUFY=false`.

## 4. Handige commando's

```bash
cd ~/deurbel
docker compose logs -f deurbel     # wat doet de app
docker compose logs -f updater     # wat doet de updater
docker compose restart             # alles herstarten
```

## 5. Vraagt Eufy om een code?

Open het dashboard en vul daar de code uit je mail in. Er verschijnt vanzelf een rood vak.

## 6. Op je telefoon

1. Open in Chrome `http://<ip-van-je-server>:8080` en vul je pincode in.
2. Tik in het menu (⋮) op **App installeren**.
3. Meldingen instellen:
   - Installeer **ntfy** uit de Play Store.
   - Tik op **+** en abonneer je op je `NTFY_TOPIC`.
   - Zet de meldingen in ntfy op **Urgent**, zodat aanbellen ook doorkomt als je telefoon op stil staat.
   - Tik in het dashboard op Instellingen → **Testmelding sturen**.

## Android-app

Liever een echte app dan de web-app? Download **[Deurbel.apk](https://github.com/smikkelvriend/deurbel/releases/download/apk-latest/Deurbel.apk)** op je telefoon en open hem.
Android vraagt dan of je apps uit deze bron wilt toestaan; zeg ja.

- Bij de eerste keer vul je het adres van je server in, bijvoorbeeld `http://192.168.0.236:8095`, en log je in met je pincode.
- **Meldingen komen rechtstreeks van je server.** ntfy is niet meer nodig. Zet onder Instellingen → Android-app de batterijbesparing voor Deurbel uit, anders kan Android de verbinding verbreken.
- Bij aanbellen gaat je scherm aan en krijg je een melding met de foto. Tik op **Live bekijken** om meteen het beeld te openen.
- Opnames en foto's die je opslaat, komen in `Downloads/Deurbel`.
- Nieuwe versies worden door GitHub gebouwd. De app meldt zelf als er een update is.
- Buiten de deur werken meldingen en live beeld alleen via Tailscale (zie hieronder).

## 7. Onderweg kijken en terugpraten (Tailscale)

Je browser geeft de microfoon alleen vrij via **HTTPS**. Tailscale regelt dat gratis en zorgt er tegelijk voor dat je ook buiten de deur kunt kijken:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
sudo tailscale serve --bg 8095   # jouw PORT uit .env
```

1. Installeer Tailscale ook op je telefoon en log in met hetzelfde account.
2. Open voortaan `https://<servernaam>.<jouw-tailnet>.ts.net`. Het adres staat in de uitvoer van `tailscale serve`.
3. Installeer de app opnieuw vanaf dat adres.
4. Zet dat adres bij `PUBLIC_URL` in `.env` en voer `docker compose up -d` uit.

Zet de poort van het dashboard niet zomaar open in je router.

## Beveiliging

eufy-security-ws (poort 3000) heeft zelf geen wachtwoord. Gebruik je de firewall `ufw`, sluit die poort dan af:

```bash
sudo ufw deny 3000
sudo ufw allow 8095   # jouw PORT
```

## Goed om te weten

- **Live beeld kost batterij.** De deurbel moet wakker worden, dus het duurt een paar seconden. Na de ingestelde tijd stopt het beeld vanzelf (standaard 5 minuten).
- **Opnames downloaden kost ook batterij.** Daarom staat het standaard op **Belangrijk**: alleen opnames bij aanbellen, personen en pakketten. Andere opnames haal je met één tik op ("Naar server halen") zolang ze nog op de deurbel staan.
- **Een gewiste opname** of een opname die verdween omdat de opslag vol was, wordt niet opnieuw automatisch gedownload.
- **Eufy's cloud** wordt nog gebruikt om in te loggen, voor de lijst met opnames en om meldingen van de deurbel door te geven. Beeld, geluid en downloads gaan zoveel mogelijk rechtstreeks over je eigen netwerk.

## Problemen?

| Probleem | Oplossing |
|---|---|
| `Server offline` | `docker compose logs eufy`: kloppen e-mailadres en wachtwoord? |
| Geen deurbel gevonden | Is hij gedeeld met het juiste account (stap 1)? |
| Live beeld blijft laden | De deurbel slaapt diep of de wifi is zwak. Probeer het nog eens. |
| Geen geluid | Tik op 🔊 in het beeld. Staat de microfoon van de deurbel aan (Instellingen)? |
| Praten werkt niet | Je opent het dashboard niet via HTTPS (stap 7). |
| Opname blijft "Op deurbel" | Tik erop en kies "Naar server halen". Lukt het drie keer niet, dan staat hij waarschijnlijk niet meer op de deurbel. |
| Instelling wijzigen mislukt | Een gedeeld account heeft soms te weinig rechten. Gebruik je eigen account. |
