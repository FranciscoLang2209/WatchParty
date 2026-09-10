import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ProfileFields, type ProfileFieldsProps } from './ProfileFields';
import { BIO_MAX_LENGTH, DISPLAY_NAME_MAX_LENGTH } from './types';

function renderFields(props: Partial<ProfileFieldsProps> = {}) {
  const user = userEvent.setup();
  const onDisplayNameChange = vi.fn();
  const onBioChange = vi.fn();

  render(
    <ProfileFields
      displayName=""
      bio=""
      onDisplayNameChange={onDisplayNameChange}
      onBioChange={onBioChange}
      {...props}
    />,
  );

  return { user, onDisplayNameChange, onBioChange };
}

const nombre = () => screen.getByLabelText('Nombre visible');
const biografia = () => screen.getByLabelText('Biografía');

describe('ProfileFields: qué se ve', () => {
  it('presenta los dos campos con su nombre accesible', () => {
    renderFields();

    expect(nombre()).toBeInTheDocument();
    expect(biografia()).toBeInTheDocument();
    // Sólo esos dos: el favorito es de WAT-134 y no vive acá.
    expect(screen.getAllByRole('textbox')).toHaveLength(2);
  });

  it('muestra los valores que recibe por props', () => {
    renderFields({ displayName: 'Martina', bio: 'Hincha de siempre.' });

    expect(nombre()).toHaveValue('Martina');
    expect(biografia()).toHaveValue('Hincha de siempre.');
  });

  it('no inventa contenido cuando el perfil está vacío', () => {
    renderFields();

    expect(nombre()).toHaveValue('');
    expect(biografia()).toHaveValue('');
  });
});

describe('ProfileFields: los límites del backend', () => {
  it('exige el nombre visible y lo corta en 50', () => {
    renderFields();

    expect(nombre()).toBeRequired();
    expect(nombre()).toHaveAttribute('maxlength', String(DISPLAY_NAME_MAX_LENGTH));
  });

  it('deja la biografía opcional y la corta en 280', () => {
    renderFields();

    expect(biografia()).not.toBeRequired();
    expect(biografia()).toHaveAttribute('maxlength', String(BIO_MAX_LENGTH));
  });

  it('usa los mismos límites que declara el contrato', () => {
    renderFields();

    // Si el backend cambia sus límites, se cambian en types.ts y esto sigue.
    expect(DISPLAY_NAME_MAX_LENGTH).toBe(50);
    expect(BIO_MAX_LENGTH).toBe(280);
  });

  it('el límite nativo impide escribir de más', async () => {
    const { user, onDisplayNameChange } = renderFields();

    await user.type(nombre(), 'x'.repeat(DISPLAY_NAME_MAX_LENGTH + 10));

    const ultimo = onDisplayNameChange.mock.calls.at(-1)?.[0] as string;

    expect(ultimo.length).toBeLessThanOrEqual(DISPLAY_NAME_MAX_LENGTH);
  });
});

/** Contenedor con estado: así lo va a cablear ProfilePage en WAT-134. */
function ControlledFields() {
  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');

  return (
    <ProfileFields
      displayName={displayName}
      bio={bio}
      onDisplayNameChange={setDisplayName}
      onBioChange={setBio}
    />
  );
}

describe('ProfileFields: los cambios salen por props', () => {
  it('avisa el cambio del nombre visible con el valor tipeado', async () => {
    const { user, onDisplayNameChange } = renderFields();

    await user.type(nombre(), 'A');

    expect(onDisplayNameChange).toHaveBeenCalledWith('A');
  });

  it('avisa el cambio de la biografía con el valor tipeado', async () => {
    const { user, onBioChange } = renderFields();

    await user.type(biografia(), 'H');

    expect(onBioChange).toHaveBeenCalledWith('H');
  });

  it('escribe de corrido cuando quien lo usa devuelve el valor', async () => {
    const user = userEvent.setup();

    render(<ControlledFields />);

    await user.type(nombre(), 'Ana');
    await user.type(biografia(), 'Hola');

    expect(nombre()).toHaveValue('Ana');
    expect(biografia()).toHaveValue('Hola');
  });

  it('no guarda estado propio: el valor lo manda quien lo usa', async () => {
    const { user, onDisplayNameChange } = renderFields({ displayName: 'Fijo' });

    await user.type(nombre(), 'x');

    // El componente es controlado: avisa el cambio pero no se lo aplica solo.
    expect(onDisplayNameChange).toHaveBeenCalled();
    expect(nombre()).toHaveValue('Fijo');
  });
});

describe('ProfileFields: estado editable', () => {
  it('deja editar por defecto', () => {
    renderFields();

    expect(nombre()).toBeEnabled();
    expect(biografia()).toBeEnabled();
  });

  it('bloquea los dos campos mientras no se puede editar', () => {
    renderFields({ disabled: true });

    expect(nombre()).toBeDisabled();
    expect(biografia()).toBeDisabled();
  });
});

describe('ProfileFields: los errores son accesibles', () => {
  it('no anuncia nada cuando no hay error', () => {
    renderFields();

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(nombre()).toHaveAttribute('aria-invalid', 'false');
    expect(biografia()).toHaveAttribute('aria-invalid', 'false');
  });

  it('asocia el error del nombre a su campo', () => {
    renderFields({ errors: { displayName: 'El nombre visible es obligatorio.' } });

    const alerta = screen.getByRole('alert');

    expect(alerta).toHaveTextContent('El nombre visible es obligatorio.');
    expect(nombre()).toHaveAttribute('aria-invalid', 'true');
    // El mensaje se lee junto al campo, no suelto en la página.
    expect(nombre().getAttribute('aria-describedby')).toBe(alerta.id);
  });

  it('asocia el error de la biografía a su campo', () => {
    renderFields({ errors: { bio: 'La biografía es demasiado larga.' } });

    const alerta = screen.getByRole('alert');

    expect(alerta).toHaveTextContent('La biografía es demasiado larga.');
    expect(biografia()).toHaveAttribute('aria-invalid', 'true');
    expect(biografia().getAttribute('aria-describedby')).toBe(alerta.id);
  });

  it('marca sólo el campo que falla', () => {
    renderFields({ errors: { displayName: 'El nombre visible es obligatorio.' } });

    expect(nombre()).toHaveAttribute('aria-invalid', 'true');
    expect(biografia()).toHaveAttribute('aria-invalid', 'false');
  });

  it('muestra los dos errores a la vez si los dos fallan', () => {
    renderFields({
      errors: { displayName: 'Falta el nombre.', bio: 'Biografía muy larga.' },
    });

    expect(screen.getAllByRole('alert')).toHaveLength(2);
  });
});

describe('ProfileFields: lo que no hace', () => {
  it('no consulta ninguna API al renderizar', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    renderFields({ displayName: 'Martina', bio: 'Hola' });

    // Ni Node API ni Supabase: los datos entran y salen por props.
    expect(fetchSpy).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });

  it('no impone un ancho: se adapta a donde lo pongan', () => {
    const { container } = render(
      <ProfileFields displayName="" bio="" onDisplayNameChange={vi.fn()} onBioChange={vi.fn()} />,
    );

    const raiz = container.firstElementChild as HTMLElement;

    expect(raiz.getAttribute('style')).toBeNull();
    expect(raiz.className).not.toMatch(/\bw-\[|\bmin-w-\[|\bmax-w-\[/);
  });
});

describe('ProfileFields: teclado', () => {
  it('recorre los campos en el orden visual', async () => {
    const { user } = renderFields();

    await user.tab();
    expect(nombre()).toHaveFocus();

    await user.tab();
    expect(biografia()).toHaveFocus();
  });

  it('un campo bloqueado no recibe foco', async () => {
    const { user } = renderFields({ disabled: true });

    await user.tab();

    expect(nombre()).not.toHaveFocus();
    expect(biografia()).not.toHaveFocus();
  });
});
