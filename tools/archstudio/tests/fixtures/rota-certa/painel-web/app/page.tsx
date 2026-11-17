import Link from 'next/link';

export default function Inicio() {
  return <main><Link href="/pedidos">Pedidos</Link> · <Link href="/mapa">Mapa</Link></main>;
}
