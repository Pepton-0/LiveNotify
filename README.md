I made this discord bot to detect some youtubers lives which are about ac6.
If you add this bot to your server and setup some settings, you can tell when the lives are active.

Setup
1. Install node.js and install packages in package.json
2. edit env.json_template and rename to env.json
  1. Requires discord token, youtube api key(with YouTube Data API v3)
  2. You need a discord server which has two channel: a notify channel of lives and a list channel of youtubers
  3. This bot only works at prime time from 15:00 to 24:00 and you can configure the time.
  4. The time is based on UST but you can adjust standard time with TIME_DIFF_FROM_UST. if it's 9 then UST+9 or JST.
5. node bot.js

