import { describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/supabase', () => ({ supabase: {} }));

const { subscribeToRoomComments } = await import('./realtime');

type Cliente = NonNullable<Parameters<typeof subscribeToRoomComments>[2]>;

const fila = {
  id: 'comentario-1',
  room_id: 'room-1',
  author_id: 'user-1',
  body: '¡Qué golazo!',
  client_request_id: 'req-1',
  created_at: '2026-09-24T21:00:00.000Z',
};

function crearCliente() {
  let entregar: (payload: { new: unknown }) => void = () => {};

  const channel = { on: vi.fn(), subscribe: vi.fn() };
  channel.on.mockImplementation(
    (_tipo: string, _filtro: unknown, callback: (payload: { new: unknown }) => void) => {
      entregar = callback;
      return channel;
    },
  );
  channel.subscribe.mockReturnValue(channel);

  const client = { channel: vi.fn(() => channel), removeChannel: vi.fn() };

  return {
    client: client as unknown as Cliente,
    mocks: client,
    channel,
    emitir: (row: unknown) => entregar({ new: row }),
  };
}

describe('subscribeToRoomComments', () => {
  it('se suscribe a los INSERT de room_comments filtrados por la sala', () => {
    const { client, mocks, channel } = crearCliente();

    subscribeToRoomComments('room-1', vi.fn(), client);

    expect(mocks.channel).toHaveBeenCalledWith('room-comments:room-1');
    expect(channel.on).toHaveBeenCalledWith(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'room_comments', filter: 'room_id=eq.room-1' },
      expect.any(Function),
    );
    expect(channel.subscribe).toHaveBeenCalledTimes(1);
  });

  it('entrega el comentario con el contrato público, sin campos internos', () => {
    const { client, emitir } = crearCliente();
    const onComment = vi.fn();

    subscribeToRoomComments('room-1', onComment, client);
    emitir(fila);

    expect(onComment).toHaveBeenCalledTimes(1);
    expect(onComment).toHaveBeenCalledWith({
      id: 'comentario-1',
      roomId: 'room-1',
      body: '¡Qué golazo!',
      createdAt: '2026-09-24T21:00:00.000Z',
    });
  });

  it('entrega una sola vez un comentario que llega repetido', () => {
    const { client, emitir } = crearCliente();
    const onComment = vi.fn();

    subscribeToRoomComments('room-1', onComment, client);
    emitir(fila);
    emitir(fila);

    expect(onComment).toHaveBeenCalledTimes(1);
  });

  it('ignora payloads inválidos o de otra sala', () => {
    const { client, emitir } = crearCliente();
    const onComment = vi.fn();

    subscribeToRoomComments('room-1', onComment, client);
    emitir(null);
    emitir({});
    emitir({ ...fila, id: 42 });
    emitir({ ...fila, body: undefined });
    emitir({ ...fila, room_id: 'room-2' });

    expect(onComment).not.toHaveBeenCalled();
  });

  it('al cancelar cierra el canal y deja de entregar', () => {
    const { client, mocks, channel, emitir } = crearCliente();
    const onComment = vi.fn();

    const cancelar = subscribeToRoomComments('room-1', onComment, client);
    cancelar();
    emitir(fila);

    expect(mocks.removeChannel).toHaveBeenCalledWith(channel);
    expect(onComment).not.toHaveBeenCalled();
  });
});
