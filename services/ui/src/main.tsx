import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
// Bundled with the app rather than fetched from a font CDN: the CSP allows
// fonts from this origin only, and the subsets load on demand by unicode-range.
import "@fontsource-variable/inter";
import "./theme.css";

const container = document.getElementById("root");
if (!container) throw new Error("No #root element in index.html.");

createRoot(container).render(
	<StrictMode>
		<BrowserRouter>
			<App />
		</BrowserRouter>
	</StrictMode>,
);
