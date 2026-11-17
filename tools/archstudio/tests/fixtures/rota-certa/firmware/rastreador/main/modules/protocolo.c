#include <stdio.h>

#include "protocolo.h"

int protocolo_ler_nmea(const char *linha, posicao_t *posicao)
{
    return sscanf(linha, "$GPRMC,%*f,A,%lf,%*c,%lf", &posicao->latitude, &posicao->longitude) == 2 ? 0 : -1;
}

int protocolo_codificar(const posicao_t *posicao, char *destino, size_t tamanho)
{
    return snprintf(destino, tamanho, "{\"lat\":%.6f,\"lng\":%.6f}", posicao->latitude, posicao->longitude);
}
