# Security

If you find a way for the extension or White Rabbit Helper to expose someone's browsing, to send it anywhere other than White Rabbit, or to run code it shouldn't, please tell us privately first: email contact.whiterabbt.com@gmail.com, or use GitHub's **Report a vulnerability** on this repository. Include what you did and what happened, and we'll reply within a few days.

Please don't open a public issue for it, and don't test against other people's accounts.

## Known limits

- Anything running in a White Rabbit page can ask the extension for what the page can, including other extensions you've allowed on www.whiterabbt.com. Those could read the page itself anyway. White Rabbit never loads Google's ad script in a tab where the extension is connected, and if an ad script, ad slot or ad frame shows up in a tab anyway, the extension stops handing that page anything until it's reloaded ([`extension/src/bridge.ts`](extension/src/bridge.ts)).
- White Rabbit Helper keeps its device token in your keychain, where only apps signed by White Rabbit's team can read, replace or delete it, and pairing asks you to confirm the account's email. That doesn't protect against a program with administrator rights, or one you've given Accessibility (it could click Connect for you) or Full Disk Access ([`helper/SIGNING.md`](helper/SIGNING.md)).
- Helper 1.0 kept its token in a file (`~/Library/Application Support/White Rabbit Helper/config.json`), which a program already running as you could replace with one for a different account. Installing again upgrades it. Disconnect in White Rabbit's settings, or remove the Helper, if you think that's happened.
