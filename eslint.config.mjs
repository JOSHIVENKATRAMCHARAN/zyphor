import nextConfig from "eslint-config-next";

const eslintConfig = [
  ...nextConfig,
  {
    ignores: [".next/*", "node_modules/*", "out/*", "public/*"],
    rules: {
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/purity": "warn",
      "react/no-unescaped-entities": "off",
      "@next/next/no-img-element": "warn",
    },
  },
];

export default eslintConfig;
