/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./app/**/*.{js,ts,jsx,tsx}', './lib/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        gotham: {
          black: '#0A0A0A',
          charcoal: '#151515',
          bone: '#E6E1D5',
          gold: '#F5D13B',
          blood: '#8B0000',
          green: '#4C7A5D',
          blue: '#2B3A4A',
        },
      },
      boxShadow: {
        deco: '0 0 0 1px rgba(245,209,59,0.25), 0 24px 48px rgba(0,0,0,0.55)',
      },
      keyframes: {
        float: {
          '0%, 100%': { transform: 'translateY(0px)' },
          '50%': { transform: 'translateY(-6px)' },
        },
        pulseSlow: {
          '0%, 100%': { opacity: '0.3' },
          '50%': { opacity: '0.7' },
        },
      },
      animation: {
        float: 'float 2.8s ease-in-out infinite',
        pulseSlow: 'pulseSlow 2.5s ease-in-out infinite',
      },
      fontFamily: {
        display: ['var(--font-amiri)', 'serif'],
        body: ['var(--font-cairo)', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
