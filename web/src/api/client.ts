import axios from "axios";

import { installWriteSignal } from "./writeSignal";

// In development Vite proxies /api to the local FastAPI server; in a built
// bundle the API is served from the same origin as the app. Either way a
// relative base URL is correct, so there is nothing to configure.
const client = axios.create({ baseURL: "" });

// Every write to a model announces itself from here, once; see `writeSignal`.
installWriteSignal(client);

export default client;
