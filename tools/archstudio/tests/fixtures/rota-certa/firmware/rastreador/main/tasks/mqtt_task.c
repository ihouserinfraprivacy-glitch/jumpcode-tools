#include <stdio.h>

#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "mqtt_client.h"

#include "mqtt_task.h"
#include "../config.h"
#include "../modules/fila_offline.h"
#include "../modules/protocolo.h"

#define MQTT_BROKER_URI "mqtts://mqtt.rotacerta.com.br:8883"

extern QueueHandle_t fila_posicoes;

void mqtt_task(void *parametro)
{
    esp_mqtt_client_config_t configuracao = { .broker.address.uri = MQTT_BROKER_URI };
    esp_mqtt_client_handle_t cliente = esp_mqtt_client_init(&configuracao);
    esp_mqtt_client_start(cliente);
    char topico[64];
    snprintf(topico, sizeof(topico), "veiculos/%s/posicao", ID_DISPOSITIVO_PADRAO);
    for (;;) {
        posicao_t posicao;
        if (xQueueReceive(fila_posicoes, &posicao, portMAX_DELAY)) {
            char carga[128];
            int tamanho = protocolo_codificar(&posicao, carga, sizeof(carga));
            if (esp_mqtt_client_publish(cliente, topico, carga, tamanho, 1, 0) < 0) {
                fila_offline_guardar(carga, tamanho);
            }
        }
    }
}
