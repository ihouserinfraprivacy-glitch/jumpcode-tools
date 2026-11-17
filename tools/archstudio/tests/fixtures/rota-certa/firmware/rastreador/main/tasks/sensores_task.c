#include "freertos/FreeRTOS.h"

#include "sensores_task.h"
#include "../drivers/adc_bateria.h"
#include "../drivers/i2c_sensores.h"
#include "../modules/energia.h"

void sensores_task(void *parametro)
{
    i2c_sensores_iniciar();
    for (;;) {
        float temperatura = i2c_sensores_temperatura();
        int milivolts = adc_bateria_ler();
        energia_registrar(milivolts, temperatura);
        vTaskDelay(pdMS_TO_TICKS(30000));
    }
}
