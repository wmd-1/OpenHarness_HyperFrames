# Voice register: block-frame

## From the site (DNA)
- Tone: neutral
- Heading style: Sentence case

## Transform recipe

1. Strip articles and connectives (the / a / of / and / with / to).
2. Break into 2-4 word noun-verb-noun fragments or single dominant nouns.
3. UPPERCASE all on-screen text that lands in display, chip, or button
   slots — sentence body stays sentence case.
4. Join fragments with `.` + linebreak for stacked impact, or em-dash
   `—` for a single beat of emphasis.
5. End headlines on a noun, not a verb — the brutalist stamp lands on the
   thing, not the action.
6. Brand name appears as the final clause, punctuated standalone.

**Example:**

- IN: `Higgsfield is the AI platform that helps creators generate stunning visuals in seconds`
- OUT: `CREATORS. GENERATE. STUNNING VISUALS — IN SECONDS. HIGGSFIELD.`

> Phase 4b scene workers: apply to DOM text only (headline / chip / button copy).
> Phase 2 narrator scripts are TTS-bound — do NOT uppercase or strip articles.
