import { api } from './client';

export async function entrar(email: string, senha: string) {
  const resposta = await api.post('/login', { email, senha });
  return resposta.data.token as string;
}
