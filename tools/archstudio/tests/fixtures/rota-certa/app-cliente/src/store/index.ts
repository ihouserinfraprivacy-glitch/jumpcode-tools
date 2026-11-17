import { configureStore } from '@reduxjs/toolkit';
import pedidos from './pedidosSlice';
import auth from './authSlice';

export const store = configureStore({ reducer: { pedidos, auth } });
export type Estado = ReturnType<typeof store.getState>;
