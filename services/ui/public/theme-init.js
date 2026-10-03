// Runs before the first paint (a blocking script in <head>), so the saved
// theme is applied before anything is drawn. App.tsx owns the theme from then
// on and writes the same key; light is the default for a first visit.
(function () {
	var theme = "light";
	try {
		if (window.localStorage.getItem("tms-theme") === "dark") theme = "dark";
	} catch (error) {
		// Storage can be refused in a private window; the default applies.
	}
	document.documentElement.setAttribute("data-theme", theme);
})();
