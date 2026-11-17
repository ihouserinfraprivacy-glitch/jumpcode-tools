#pragma once

#include <stddef.h>

typedef struct {
    double latitude;
    double longitude;
    float velocidade;
} posicao_t;

int protocolo_ler_nmea(const char *linha, posicao_t *posicao);
int protocolo_codificar(const posicao_t *posicao, char *destino, size_t tamanho);
