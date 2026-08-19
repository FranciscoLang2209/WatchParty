import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import App from './App';

describe('App', () => {
  it('renderiza el encabezado WatchParty con la clase text-center', () => {
    render(<App />);

    const heading = screen.getByRole('heading', { name: 'WatchParty' });

    expect(heading).toHaveClass('text-center');
  });
});
