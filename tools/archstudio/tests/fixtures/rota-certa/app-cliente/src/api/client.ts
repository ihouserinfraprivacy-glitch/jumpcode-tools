import axios from 'axios';

export const api = axios.create({ baseURL: 'https://api.rotacerta.com.br', timeout: 10000 });
