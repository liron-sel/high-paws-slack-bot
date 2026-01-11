# High-Paws Bot

Slack bot that awards and tracks "high-paws" when users add `++` next to a
mention, with an admin-only undo via :point_down: on the bot's award message.

## How It Works
- Award: `++ <@user>` or `<@user> ++` (space optional)
- Edits: Edited messages are eligible for awarding
- Undo: Admin reacts :point_down: on the bot award message to decrement 1

## Environment Variables
- `SLACK_BOT_TOKEN`
- `SLACK_APP_TOKEN`
- `HIGH_PAWS_CHANNEL_ID` (optional)
- `HIGH_PAWS_ADMIN_USER_ID` (required for undo)

## Slack App Setup (minimum)
- Event Subscriptions: `reaction_added`
- Bot Token Scopes:
  - `reactions:read`
  - `chat:write`
  - `channels:history` or `groups:history`

## Notes
- Undo only works on the specific bot award message you react to.
- The bot must be in the channel to read messages and reactions.
