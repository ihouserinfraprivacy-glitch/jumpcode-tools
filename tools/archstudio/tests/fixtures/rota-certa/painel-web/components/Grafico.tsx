export default function Grafico({ dados }: { dados: unknown[] }) {
  return <svg width={320} height={160} aria-label={`${dados.length} entregadores`} />;
}
