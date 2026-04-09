/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: "class",
  content: [
    "./app/**/*.{js,jsx,ts,tsx}",
    "./src/**/*.{js,jsx,ts,tsx}",
  ],
  presets: [require("nativewind/preset")],
  theme: {
    extend: {
      colors: {
        surface: "#151515",
        border: "#222222",
        dim: "#666666",
        faint: "#333333",
      },
      fontFamily: {
        mono: ["Menlo", "Courier"],
      },
    },
  },
  plugins: [],
};
