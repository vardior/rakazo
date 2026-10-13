# Onboarding

A new user creates an account, connects a model, may skip server integrations, and lands in the chat of an automatically created first bot, Chief, which introduces itself.

## Sub-features

- `onboard-signup` creates an account from the sign-up form.
- `onboard-model` connects the deployment's model with an API key.
- `onboard-integrations-skip` skips the optional server integrations step.
- `onboard-first-bot` creates Chief and runs its introduction turn.

## How to get to it (user POV)

- Open the site root and choose `Sign up`, or go straight to `/sign-up`.

## Driving it with control-rakazo

Preconditions:

- A fresh run from `$C up`; no account exists yet.

- **One command.** Run `$C onboard`. It drives every step below through the UI and prints `{"onboarded": true, "url": "…/app/<botId>"}`.
- **Sign up.** Run `$C browser open /sign-up`, then fill `--placeholder "Your name"`, `--placeholder "Your email address"` and `--placeholder "Password"`, and `$C browser click --role button --name "Create account"`. A heading `Connect a model` appears.
- **Connect model.** The `Provider` combobox reads `Local (Ollama / LM Studio)` and `Model` reads `verify-fixture`. Run `$C browser fill --role textbox --name "API key" --value "verify-local-key"` and `$C browser click --role button --name "Continue"`. A heading `Server integrations` appears.
- **Skip integrations.** Run `$C browser click --role button --name "Skip" --exact`. The URL becomes `/app/<botId>` and the composer `Message Chief` appears.
- **Introduction.** Wait with `$C browser wait --text "Chief is working" --state hidden --timeout 60000`. The transcript shows the card `What do you want me on first?` and a reply beginning `Fixture saw 1 new user message(s): «You were just created.`
- **Proof.** `$C browser snapshot --path <bundle>/onboarded.aria.txt` and `$C fixture-log`: call 1 has plan `ack` and zero tools.

## Gotchas

- The API key field rejects values shorter than 8 characters (`Input validation failed`).
- The introduction run uses no tools; a failed introduction leaves no error in the chat, so check the run row when the reply is missing.
