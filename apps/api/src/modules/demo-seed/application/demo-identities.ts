import { createHash } from 'node:crypto';

/**
 * Identidades sintéticas para poblar el entorno de demo. Nombres y apellidos verosímiles
 * (rioplatenses y de uso común en español), combinados de forma determinista: la identidad `n`
 * es siempre la misma, así una segunda corrida reconoce a quienes ya creó. No hay datos
 * personales de nadie ni nombres del estilo `Usuario_001`.
 */
const FIRST_NAMES = [
  'Agustina',
  'Alejandro',
  'Ariel',
  'Bautista',
  'Belén',
  'Benjamín',
  'Brenda',
  'Camila',
  'Carolina',
  'Cecilia',
  'Constanza',
  'Damián',
  'Daniela',
  'Diego',
  'Emiliano',
  'Estefanía',
  'Facundo',
  'Federico',
  'Florencia',
  'Gabriel',
  'Gonzalo',
  'Guadalupe',
  'Ignacio',
  'Isabella',
  'Joaquín',
  'Julieta',
  'Lautaro',
  'Lucía',
  'Luciana',
  'Marcos',
  'Martina',
  'Matías',
  'Maximiliano',
  'Milagros',
  'Nicolás',
  'Noelia',
  'Octavio',
  'Pablo',
  'Paula',
  'Rocío',
  'Rodrigo',
  'Romina',
  'Santiago',
  'Sebastián',
  'Sofía',
  'Tomás',
  'Valentín',
  'Valeria',
  'Victoria',
  'Yamila',
  'Andrés',
  'Candela',
  'Esteban',
  'Mariana',
  'Nahuel',
  'Pilar',
  'Ramiro',
  'Sol',
  'Thiago',
  'Ailén',
];

const LAST_NAMES = [
  'Acosta',
  'Aguirre',
  'Álvarez',
  'Benítez',
  'Blanco',
  'Bustos',
  'Cabrera',
  'Castro',
  'Chávez',
  'Correa',
  'Cruz',
  'Delgado',
  'Díaz',
  'Domínguez',
  'Duarte',
  'Escobar',
  'Fernández',
  'Ferreyra',
  'Flores',
  'Frías',
  'Gallo',
  'García',
  'Giménez',
  'Gómez',
  'González',
  'Gutiérrez',
  'Herrera',
  'Ibáñez',
  'Juárez',
  'Lemos',
  'López',
  'Luna',
  'Maldonado',
  'Medina',
  'Méndez',
  'Molina',
  'Morales',
  'Moreno',
  'Muñoz',
  'Navarro',
  'Núñez',
  'Ojeda',
  'Ortiz',
  'Paz',
  'Peralta',
  'Pereyra',
  'Pérez',
  'Quiroga',
  'Ramírez',
  'Ramos',
  'Reyes',
  'Rivas',
  'Rodríguez',
  'Rojas',
  'Romero',
  'Ruiz',
  'Salazar',
  'Sánchez',
  'Sosa',
  'Suárez',
  'Torres',
  'Vargas',
  'Vega',
  'Villalba',
  'Yáñez',
  'Zárate',
  'Benavídez',
  'Carrizo',
  'Coronel',
  'Godoy',
  'Leiva',
  'Montenegro',
  'Orellana',
  'Palacios',
  'Roldán',
  'Sandoval',
  'Toledo',
  'Villarreal',
  'Zapata',
];

const BIOS = [
  'Hincha de toda la vida. Los domingos no se negocian.',
  'Veo todos los partidos que puedo, aunque sea en el celu.',
  'Entre el asado y el partido, siempre elijo las dos cosas.',
  'Fanático del fútbol y de las tertulias de después del partido.',
  'Me gusta analizar los partidos y discutirlos con amigos.',
  'Siempre con la camiseta puesta, gane o pierda mi equipo.',
  'Del barrio a la tribuna: el fútbol es parte de la familia.',
  'Armo el grupo para ver los partidos juntos.',
  'Más de miradas y charlas que de gritos, pero me emociono igual.',
  'Aprendiendo a ver el juego más allá del resultado.',
  'Cuando hay clásico, nadie me encuentra.',
  'Colecciono partidos inolvidables y los comento acá.',
];

export interface DemoIdentity {
  displayName: string;
  /** Nombre en minúsculas y sin acentos, para armar el correo. */
  emailLocalPart: string;
  bio: string;
}

function slug(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

/** Capacidad de combinaciones únicas: cualquier índice por debajo es una persona distinta. */
export const MAX_UNIQUE_IDENTITIES = FIRST_NAMES.length * LAST_NAMES.length;

/**
 * La identidad `index` (1, 2, 3…). Dentro de un mismo nombre de pila, el apellido avanza con un
 * paso coprimo con la cantidad de apellidos, así que dos índices distintos nunca dan el mismo par.
 */
export function buildIdentity(index: number): DemoIdentity {
  if (!Number.isInteger(index) || index < 1 || index > MAX_UNIQUE_IDENTITIES) {
    throw new RangeError(`El índice de identidad debe estar entre 1 y ${MAX_UNIQUE_IDENTITIES}.`);
  }

  const zero = index - 1;
  const firstIndex = zero % FIRST_NAMES.length;
  const round = Math.floor(zero / FIRST_NAMES.length);
  const lastIndex = (round * 7 + firstIndex * 11) % LAST_NAMES.length;
  const first = FIRST_NAMES[firstIndex]!;
  const last = LAST_NAMES[lastIndex]!;

  return {
    displayName: `${first} ${last}`,
    emailLocalPart: `${slug(first)}.${slug(last)}.${String(index).padStart(3, '0')}`,
    bio: BIOS[zero % BIOS.length]!,
  };
}

/**
 * Equipo favorito de la identidad `index` entre los equipos existentes: reparte la elección de
 * forma pareja y estable. Sin equipos, no hay favorito.
 */
export function pickFavoriteTeamId(index: number, teamIds: readonly string[]): string | null {
  if (teamIds.length === 0) return null;

  return teamIds[(index * 7919) % teamIds.length]!;
}

/**
 * UUID determinista para una clave de idempotencia (`client_request_id` de un comentario). La misma
 * clave da siempre el mismo UUID: repetir la carga reconoce el comentario ya creado.
 */
export function deterministicUuid(...parts: string[]): string {
  const hex = createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32).split('');

  hex[12] = '4';
  hex[16] = '89ab'[Number.parseInt(hex[16]!, 16) % 4]!;

  const text = hex.join('');

  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
}
