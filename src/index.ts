import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const app = await createApp(loadConfig());
const port = Number(process.env.PORT || 8787);
app.listen(port, () => console.log(`AutoShip API listening on http://localhost:${port}`));
